pragma solidity ^0.5.0;

// import "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";
import "openzeppelin-solidity/contracts/math/SafeMath.sol";


/* solhint-disable max-line-length */
contract HoprChannel {
    using SafeMath for uint256;
    // using ECDSA for bytes32;
    
    // constant RELAY_FEE = 1
    uint256 constant private TIME_CONFIRMATION = 1 minutes; // testnet value TODO: adjust for mainnet use
    
    // Tell payment channel partners that the channel has been settled and closed
    event ClosedChannel(bytes32 indexed channelId, bytes16 index, uint256 amountA) anonymous;

    // Tell payment channel partners that the channel has been opened
    event OpenedChannel(bytes32 channelId, uint256 amount);

    // Track the state of the channels
    enum ChannelState {
        UNINITIALIZED, // 0
        PARTYA_FUNDED, // 1
        PARTYB_FUNDED, // 2
        ACTIVE, // 3
        PENDING_SETTLEMENT // 4
    }

    struct Channel {
        ChannelState state;
        uint256 balance;
        uint256 balanceA;
        bytes16 index;
        uint256 settleTimestamp;
    }

    // Open channels
    mapping(bytes32 => Channel) public channels;
    
    struct State {
        bool isSet;
        // number of open channels
        // Note: the smart contract doesn't know the actual
        //       channels but it knows how many open ones
        //       there are.
        uint256 openChannels;
        uint256 stakedEther;
    }

    // Keeps track of the states of the
    // participating parties.
    mapping(address => State) public states;

    // Keeps track of the nonces that have
    // been used to open payment channels
    mapping(bytes16 => bool) public nonces;

    modifier enoughFunds(uint256 amount) {
        require(amount <= states[msg.sender].stakedEther, "Insufficient funds.");
        _;
    }

    /**
    * @notice desposit ether to stake
    */
    function() external payable {
        if (msg.value > 0) {
            if (!states[msg.sender].isSet) {
                states[msg.sender].isSet = true;
            }
            states[msg.sender].stakedEther = states[msg.sender].stakedEther.add(uint256(msg.value));
        }
    }
    
    /**
    * @notice withdrawal staked ether
    * @param amount uint256
    */
    function unstakeEther(uint256 amount) public enoughFunds(amount) {
        require(states[msg.sender].openChannels == 0, "Waiting for remaining channels to close.");

        if (amount == states[msg.sender].stakedEther) {
            delete states[msg.sender];
        } else {
            states[msg.sender].stakedEther = states[msg.sender].stakedEther.sub(amount);
        }

        msg.sender.transfer(amount);
    }
    
    /**
    * @notice create payment channel TODO: finish desc
    * @param counterParty address of the counter party
    * @param amount uint256
    */
    // function create(address counterParty, uint256 amount) public enoughFunds(amount) {
    //     require(channels[getId(counterParty)].state == ChannelState.UNINITIALIZED, "Channel already exists.");
        
    //     states[msg.sender].stakedEther = states[msg.sender].stakedEther.sub(amount);
        
    //     // Register the channels at both participants' state
    //     states[msg.sender].openChannels = states[msg.sender].openChannels.add(1);
    //     states[counterParty].openChannels = states[counterParty].openChannels.add(1);
        
    //     if (isPartyA(counterParty)) {
    //         // msg.sender == partyB
    //         channels[getId(counterParty)] = Channel(ChannelState.PARTYB_FUNDED, amount, 0, 0, 0);
    //     } else {
    //         // msg.sender == partyA
    //         channels[getId(counterParty)] = Channel(ChannelState.PARTYA_FUNDED, amount, amount, 0, 0);
    //     }
    // }
    
    /**
    * @notice fund payment channel TODO: finish desc
    * @param counterParty address of the counter party
    * @param amount uint256
    */
    // function fund(address counterParty, uint256 amount) public enoughFunds(amount) channelExists(counterParty) {
    //     states[msg.sender].stakedEther = states[msg.sender].stakedEther.sub(amount);

    //     Channel storage channel = channels[getId(counterParty)];

    //     if (isPartyA(counterParty)) {
    //         // msg.sender == partyB
    //         require(channel.state == ChannelState.PARTYA_FUNDED, "Channel already exists.");
            
    //         channel.balance = channel.balance.add(amount);
    //     } else {
    //         // msg.sender == partyA
    //         require(channel.state == ChannelState.PARTYB_FUNDED, "Channel already exists.");
            
    //         channel.balance = channel.balance.add(amount);
    //         channel.balanceA = channel.balanceA.add(amount);
    //     }
    //     channel.state = ChannelState.ACTIVE;
    // }
    
    /**
    * @notice pre-fund channel by with staked Ether of both parties
    * @param nonce nonce to prevent against replay attacks
    * @param amount uint256 how much money both parties put into the channel
    * @param r bytes32 signature first part
    * @param s bytes32 signature second part
    * @param v uint8 version
     */
    function createFunded(bytes16 nonce, uint256 amount, bytes32 r, bytes32 s, uint8 v) public enoughFunds(amount) {
        require(!nonces[nonce], "Nonce was already used.");
        nonces[nonce] = true;

        bytes32 hashedMessage = keccak256(abi.encodePacked(nonce, uint128(1), amount));
        address counterparty = ecrecover(hashedMessage, v, r, s);
        
        require(states[counterparty].stakedEther >= amount, "Insufficient funds.");

        bytes32 channelId = getId(counterparty);

        require(channels[channelId].state == ChannelState.UNINITIALIZED, "Channel already exists.");

        states[msg.sender].stakedEther = states[msg.sender].stakedEther.sub(amount);
        states[counterparty].stakedEther = states[counterparty].stakedEther.sub(amount);

        states[msg.sender].openChannels = states[msg.sender].openChannels.add(1);
        states[counterparty].openChannels = states[counterparty].openChannels.add(1);
        
        channels[channelId] = Channel(ChannelState.ACTIVE, uint256(2).mul(amount), amount, 0, 0);        
    }

    /**
    * @notice settle & close multiple payment channels within 1 transaction
    * @param counterParties address[] of the counter party
    * @param indexes uint256[]
    * @param balancesA uint256[]
    * @param r bytes32[]
    * @param s bytes32[]
    * @param v bytes1[]
    */
    // function closeChannels(
    //     address[] calldata counterParties, 
    //     uint256[] calldata indexes, 
    //     uint256[] calldata balancesA, 
    //     bytes32[] calldata r, 
    //     bytes32[] calldata s, 
    //     bytes1[] calldata v) 
    //     external {
    //         uint256 length = counterParties.length;
    //         require(
    //             length == indexes.length && length == balancesA.length && length == r.length && length == s.length && length == v.length,
    //             "array length mismatched");

    //         for(uint256 i = 0; i < length; i.add(1)) {
    //             closeChannel(counterParties[i], indexes[i], balancesA[i], r[i], s[i], v[i]);
    //         }
    // }

    /**
    * @notice settle & close payment channel
    * @param index bytes16
    * @param nonce bytes16
    * @param balanceA uint256
    * @param r bytes32
    * @param s bytes32
    * @param v bytes1
    */

    function closeChannel(bytes16 index, bytes16 nonce, uint256 balanceA, bytes32 r, bytes32 s, uint8 v) public {
        bytes32 hashedMessage = keccak256(abi.encodePacked(nonce, index, balanceA));
        address counterparty = ecrecover(hashedMessage, v, r, s);

        bytes32 channelId = getId(counterparty);
        Channel storage channel = channels[channelId];
        
        require(
            channel.index < index &&
            channel.state == ChannelState.ACTIVE || channel.state == ChannelState.PENDING_SETTLEMENT,
            "Invalid channel.");
        
        channel.balanceA = balanceA;
        channel.index = index;
        channel.state = ChannelState.PENDING_SETTLEMENT;
        channel.settleTimestamp = block.timestamp.add(TIME_CONFIRMATION);
        
        emit ClosedChannel(channelId, index, balanceA);
    }
    
    /**
    * @notice withdrawal pending balance from payment channel
    * @param counterParty address of the counter party
    */
    function withdraw(address counterParty) public  {
        bytes32 channelId = getId(counterParty);
        Channel storage channel = channels[channelId];
        
        if (channel.state == ChannelState.PENDING_SETTLEMENT) {
            require(channel.settleTimestamp <= block.timestamp, "Channel not withdrawable yet.");
                        
            require(
                states[msg.sender].openChannels > 0 &&
                states[counterParty].openChannels > 0, 
                "Something went wrong. Double spend?");

            states[msg.sender].openChannels = states[msg.sender].openChannels.sub(1);
            states[counterParty].openChannels = states[counterParty].openChannels.sub(1);
            
            if (isPartyA(counterParty)) {
                // msg.sender == partyB
                states[msg.sender].stakedEther = states[msg.sender].stakedEther.add((channel.balance.sub(channel.balanceA)));
                states[counterParty].stakedEther = states[counterParty].stakedEther.add(channel.balanceA);
            } else {
                // msg.sender == partyA
                states[counterParty].stakedEther = states[counterParty].stakedEther.add((channel.balance.sub(channel.balanceA)));
                states[msg.sender].stakedEther = states[msg.sender].stakedEther.add(channel.balanceA); 
            }

            delete channels[channelId];
        }
    }

    /*** PRIVATE | INTERNAL ***/
    /**
    * @notice compares addresses `msg.sender` vs `counterParty` 
    * @param counterParty address of the counter party
    * @return bool 
    */
    function isPartyA(address counterParty) private view returns (bool) {
        require(msg.sender != counterParty, "Cannot open channel between one party.");

        return bytes20(msg.sender) < bytes20(counterParty);
    }

    /**
    * @notice returns keccak256 hash of `counterParty` & `msg.sender` which is used as an id
    * @dev order of arguements pending result of `isPartyA(counterParty)`
    * @param counterParty address of the counter party
    * @return bytes32 
    */
    function getId(address counterParty) private view returns (bytes32) {
        if (isPartyA(counterParty)) {
            return keccak256(abi.encodePacked(msg.sender, counterParty));
        } else {
            return keccak256(abi.encodePacked(counterParty, msg.sender));
        }
    }
}