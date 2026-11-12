// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";
import {SomniaExtensions} from "@somnia-chain/reactivity-contracts/contracts/interfaces/SomniaExtensions.sol";

interface IMarginBank {
    function getPosition(address account, address perpPool)
        external
        view
        returns (int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs);
}

interface IPerpPool {
    function getMarkPrice() external view returns (uint256);

    function placeOrderFor(
        address owner,
        bool isBid,
        uint64 userData,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k
    ) external payable returns (bool success, uint128 orderId);
}

/// @title StopCheckReactor
/// @notice The StopCheck gap keeper as an on-chain Somnia Reactivity handler.
///
/// dreamDEX stores an "Entire" TP/SL with the size the position had when it was set,
/// so after the trader adds to the position the stop only closes part of it. When a
/// linked TP/SL of the guarded account fires, the stop registry emits
/// LinkedOrderCancelled with the owner as an indexed topic. This contract is
/// subscribed to that event through the Reactivity precompile, so the chain itself
/// calls it right after the stop, and it closes whatever is still open with a
/// reduce IOC order through placeOrderFor. No server is involved.
///
/// The account has to link this contract with Link a bot (placeOrderFor on the
/// pool). The operator grant can only place and cancel orders for the account, it
/// cannot withdraw. The contract never opens or adds: the order is always on the
/// opposite side of the live position and never bigger than it.
contract StopCheckReactor is SomniaEventHandler {
    /// LinkedOrderCancelled(uint128 indexed cancelledOrderId, uint128 indexed triggeredOrderId,
    ///                      address indexed owner, uint256 somiCredited)
    bytes32 public constant LINKED_ORDER_CANCELLED = keccak256("LinkedOrderCancelled(uint128,uint128,address,uint256)");

    /// dreamDEX order type used by the hosted keeper for its closes (immediate or cancel).
    uint8 public constant ORDER_TYPE_IOC = 2;
    uint256 public constant BPS = 10_000;

    struct Market {
        address pool;
        uint256 tickSize;
        uint256 subscriptionId;
    }

    address public immutable admin;
    address public immutable account;
    IMarginBank public immutable marginBank;
    /// How far past the mark the IOC may fill, in basis points.
    uint256 public immutable slippageBps;

    /// Stop registry (the event emitter) to the market it guards.
    mapping(address registry => Market) public markets;
    uint256 public closes;

    event Watching(address indexed registry, address indexed pool, uint256 subscriptionId);
    event Unwatched(address indexed registry, uint256 subscriptionId);
    event GapClosed(address indexed pool, bool isBid, uint256 quantity, uint256 price, bool success, uint128 orderId);
    event CloseFailed(address indexed pool, bytes reason);
    event NothingOpen(address indexed pool);

    error NotAdmin();
    error AlreadyWatching();
    error NotWatching();
    error BadSlippage();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address account_, address marginBank_, uint256 slippageBps_) payable {
        if (slippageBps_ == 0 || slippageBps_ >= BPS) revert BadSlippage();
        admin = msg.sender;
        account = account_;
        marginBank = IMarginBank(marginBank_);
        slippageBps = slippageBps_;
    }

    receive() external payable {}

    /// @notice Subscribe to the stop registry of one market. The contract must hold
    /// 32 STT when this is called (Somnia's sybil check); the balance also pays for
    /// the handler calls.
    function watch(address registry, address pool, uint256 tickSize, uint64 gasLimit, uint64 priorityFeePerGas)
        external
        onlyAdmin
        returns (uint256 subscriptionId)
    {
        if (markets[registry].pool != address(0)) revert AlreadyWatching();
        SomniaExtensions.SubscriptionFilter memory filter = SomniaExtensions.SubscriptionFilter({
            eventTopics: [LINKED_ORDER_CANCELLED, bytes32(0), bytes32(0), bytes32(uint256(uint160(account)))],
            origin: address(0),
            emitter: registry
        });
        SomniaExtensions.SubscriptionOptions memory options = SomniaExtensions.SubscriptionOptions({
            priorityFeePerGas: priorityFeePerGas,
            maxFeePerGas: 0,
            gasLimit: gasLimit
        });
        subscriptionId = SomniaExtensions.subscribe(address(this), filter, options);
        markets[registry] = Market({pool: pool, tickSize: tickSize, subscriptionId: subscriptionId});
        emit Watching(registry, pool, subscriptionId);
    }

    function unwatch(address registry) external onlyAdmin {
        Market memory m = markets[registry];
        if (m.pool == address(0)) revert NotWatching();
        delete markets[registry];
        SomniaExtensions.unsubscribe(m.subscriptionId);
        emit Unwatched(registry, m.subscriptionId);
    }

    /// @notice Return the STT left after the bounty: only to the admin.
    function withdraw(uint256 amount) external onlyAdmin {
        (bool ok,) = admin.call{value: amount}("");
        require(ok);
    }

    function _onEvent(address emitter, bytes32[] calldata eventTopics, bytes calldata) internal override {
        // The precompile already filters, but a handler should not trust its subscription alone.
        if (eventTopics.length < 4 || eventTopics[0] != LINKED_ORDER_CANCELLED) return;
        if (address(uint160(uint256(eventTopics[3]))) != account) return;
        Market memory m = markets[emitter];
        if (m.pool == address(0)) return;

        (int128 size,,,) = marginBank.getPosition(account, m.pool);
        if (size == 0) {
            emit NothingOpen(m.pool);
            return;
        }
        // Closing a long sells, closing a short buys. Quantity is the live size, which
        // is already on the lot grid, so the order can only reduce and never flip.
        bool isBid = size < 0;
        uint256 quantity = uint256(uint128(size < 0 ? -size : size));
        uint256 price = limitPrice(IPerpPool(m.pool).getMarkPrice(), m.tickSize, isBid);
        uint64 expire = uint64((block.timestamp + 300) * 1e9);

        try IPerpPool(m.pool).placeOrderFor(
            account, isBid, 0, price, quantity, expire, ORDER_TYPE_IOC, 0, address(0), 0
        ) returns (bool success, uint128 orderId) {
            if (success) closes += 1;
            emit GapClosed(m.pool, isBid, quantity, price, success, orderId);
        } catch (bytes memory reason) {
            emit CloseFailed(m.pool, reason);
        }
    }

    /// @notice Worst price the IOC accepts: below the mark when selling, above when buying,
    /// aligned to the tick so the pool accepts it.
    function limitPrice(uint256 mark, uint256 tick, bool isBid) public view returns (uint256) {
        if (isBid) {
            uint256 up = (mark * (BPS + slippageBps)) / BPS;
            return ((up + tick - 1) / tick) * tick;
        }
        uint256 down = (mark * (BPS - slippageBps)) / BPS;
        return (down / tick) * tick;
    }
}
