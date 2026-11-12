// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StopCheckReactor} from "../src/StopCheckReactor.sol";
import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";
import {ISomniaReactivityPrecompile} from
    "@somnia-chain/reactivity-contracts/contracts/interfaces/ISomniaReactivityPrecompile.sol";

contract MockBank {
    mapping(address => mapping(address => int128)) public sizes;

    function set(address account, address pool, int128 size) external {
        sizes[account][pool] = size;
    }

    function getPosition(address account, address pool) external view returns (int128, uint128, int256, uint64) {
        return (sizes[account][pool], 0, 0, 0);
    }
}

contract MockPool {
    uint256 public mark;
    bool public reject;
    uint256 public calls;
    address public lastOwner;
    bool public lastIsBid;
    uint256 public lastPrice;
    uint256 public lastQty;
    uint8 public lastType;
    address public lastSender;

    function setMark(uint256 m) external {
        mark = m;
    }

    function setReject(bool r) external {
        reject = r;
    }

    function getMarkPrice() external view returns (uint256) {
        return mark;
    }

    function placeOrderFor(address owner, bool isBid, uint64, uint256 price, uint256 quantity, uint64, uint8 orderType, uint8, address, uint96)
        external
        payable
        returns (bool, uint128)
    {
        require(!reject, "operator not authorized");
        calls += 1;
        lastOwner = owner;
        lastIsBid = isBid;
        lastPrice = price;
        lastQty = quantity;
        lastType = orderType;
        lastSender = msg.sender;
        return (true, 42);
    }
}

/// Stands in for the Reactivity precompile at 0x0100: records the last subscription.
contract MockPrecompile {
    uint256 public next = 7;
    bytes32 public topic3;
    address public emitter;
    address public handler;
    uint64 public gasLimit;
    uint256 public unsubscribed;

    function subscribe(ISomniaReactivityPrecompile.SubscriptionData calldata d) external returns (uint256) {
        topic3 = d.eventTopics[3];
        emitter = d.emitter;
        handler = d.handlerContractAddress;
        gasLimit = d.gasLimit;
        return next++;
    }

    function unsubscribe(uint256 id) external {
        unsubscribed = id;
    }
}

contract StopCheckReactorTest is Test {
    address constant PRECOMPILE = address(0x0100);
    address constant ACCOUNT = 0x84326A92162Ece92ed257A31073fDd3a6599BF21;
    address constant REGISTRY = address(0x1C3F);
    uint256 constant TICK = 1e15; // LINK tick

    StopCheckReactor reactor;
    MockBank bank;
    MockPool pool;

    function setUp() public {
        vm.etch(PRECOMPILE, address(new MockPrecompile()).code);
        // etch copies code, not storage: start subscription ids at 7 like the mock's initializer
        vm.store(PRECOMPILE, bytes32(0), bytes32(uint256(7)));
        bank = new MockBank();
        pool = new MockPool();
        pool.setMark(10.03e18);
        reactor = new StopCheckReactor(ACCOUNT, address(bank), 200);
        vm.deal(address(reactor), 33 ether);
        reactor.watch(REGISTRY, address(pool), TICK, 5_000_000, 0);
    }

    function topics(address owner) internal pure returns (bytes32[] memory t) {
        t = new bytes32[](4);
        t[0] = keccak256("LinkedOrderCancelled(uint128,uint128,address,uint256)");
        t[1] = bytes32(uint256(11));
        t[2] = bytes32(uint256(12));
        t[3] = bytes32(uint256(uint160(owner)));
    }

    function fire(address emitter, address owner) internal {
        vm.prank(PRECOMPILE);
        reactor.onEvent(emitter, topics(owner), abi.encode(uint256(0.15 ether)));
    }

    function test_subscribesToTheRegistryWithTheOwnerTopic() public view {
        MockPrecompile p = MockPrecompile(PRECOMPILE);
        assertEq(p.emitter(), REGISTRY);
        assertEq(p.handler(), address(reactor));
        assertEq(p.topic3(), bytes32(uint256(uint160(ACCOUNT))));
        assertEq(p.gasLimit(), 5_000_000);
        (address poolAddr,, uint256 subId) = reactor.markets(REGISTRY);
        assertEq(poolAddr, address(pool));
        assertEq(subId, 7);
    }

    function test_closesTheLongThatTheStopLeftOpen() public {
        bank.set(ACCOUNT, address(pool), 2.9e18);
        fire(REGISTRY, ACCOUNT);
        assertEq(pool.calls(), 1);
        assertEq(pool.lastOwner(), ACCOUNT);
        assertFalse(pool.lastIsBid(), "closing a long sells");
        assertEq(pool.lastQty(), 2.9e18);
        assertEq(pool.lastType(), 2);
        assertEq(pool.lastSender(), address(reactor));
        // 10.03 * 0.98 = 9.8294, down to the 0.001 tick
        assertEq(pool.lastPrice(), 9.829e18);
        assertEq(reactor.closes(), 1);
    }

    function test_closesAShortByBuyingAboveTheMark() public {
        bank.set(ACCOUNT, address(pool), -1.7e18);
        fire(REGISTRY, ACCOUNT);
        assertTrue(pool.lastIsBid());
        assertEq(pool.lastQty(), 1.7e18);
        // 10.03 * 1.02 = 10.2306, up to the tick
        assertEq(pool.lastPrice(), 10.231e18);
    }

    function test_doesNothingWhenTheStopClosedEverything() public {
        bank.set(ACCOUNT, address(pool), 0);
        fire(REGISTRY, ACCOUNT);
        assertEq(pool.calls(), 0);
        assertEq(reactor.closes(), 0);
    }

    function test_ignoresOtherOwners() public {
        bank.set(ACCOUNT, address(pool), 2.9e18);
        fire(REGISTRY, address(0xBEEF));
        assertEq(pool.calls(), 0);
    }

    function test_ignoresUnknownEmitters() public {
        bank.set(ACCOUNT, address(pool), 2.9e18);
        fire(address(0xDEAD), ACCOUNT);
        assertEq(pool.calls(), 0);
    }

    function test_ignoresOtherEvents() public {
        bank.set(ACCOUNT, address(pool), 2.9e18);
        bytes32[] memory t = topics(ACCOUNT);
        t[0] = keccak256("PendingOrderTriggered(uint128,bool,uint8,uint128)");
        vm.prank(PRECOMPILE);
        reactor.onEvent(REGISTRY, t, "");
        assertEq(pool.calls(), 0);
    }

    function test_onlyThePrecompileCanCallTheHandler() public {
        bank.set(ACCOUNT, address(pool), 2.9e18);
        vm.expectRevert(SomniaEventHandler.OnlyReactivityPrecompile.selector);
        reactor.onEvent(REGISTRY, topics(ACCOUNT), "");
    }

    function test_aRejectedOrderDoesNotRevertTheCallback() public {
        bank.set(ACCOUNT, address(pool), 2.9e18);
        pool.setReject(true);
        fire(REGISTRY, ACCOUNT);
        assertEq(reactor.closes(), 0);
    }

    function test_onlyAdminManagesSubscriptionsAndFunds() public {
        vm.startPrank(address(0xBAD));
        vm.expectRevert(StopCheckReactor.NotAdmin.selector);
        reactor.watch(address(0x2), address(pool), TICK, 5_000_000, 0);
        vm.expectRevert(StopCheckReactor.NotAdmin.selector);
        reactor.unwatch(REGISTRY);
        vm.expectRevert(StopCheckReactor.NotAdmin.selector);
        reactor.withdraw(1 ether);
        vm.stopPrank();
    }

    function test_watchNeeds32Stt() public {
        StopCheckReactor poor = new StopCheckReactor(ACCOUNT, address(bank), 200);
        vm.deal(address(poor), 31 ether);
        vm.expectRevert();
        poor.watch(REGISTRY, address(pool), TICK, 5_000_000, 0);
    }

    function test_unwatchStopsTheMarket() public {
        reactor.unwatch(REGISTRY);
        assertEq(MockPrecompile(PRECOMPILE).unsubscribed(), 7);
        bank.set(ACCOUNT, address(pool), 2.9e18);
        fire(REGISTRY, ACCOUNT);
        assertEq(pool.calls(), 0);
    }

    function testFuzz_neverMoreThanThePositionAndAlwaysOpposite(int128 size, uint96 mark) public {
        vm.assume(size != 0 && size > -1e30 && size < 1e30 && mark > 1e15);
        pool.setMark(mark);
        bank.set(ACCOUNT, address(pool), size);
        fire(REGISTRY, ACCOUNT);
        uint256 abs = uint256(uint128(size < 0 ? -size : size));
        assertEq(pool.lastQty(), abs);
        assertEq(pool.lastIsBid(), size < 0);
        assertEq(pool.lastPrice() % TICK, 0);
        if (size > 0) assertLe(pool.lastPrice(), mark);
        else assertGe(pool.lastPrice(), mark);
    }
}
