# tornado-core local
This repo is a fork of [tornado-core](https://github.com/tornadocash/tornado-core) repository with a single tiny update -\
for educational purposes only, the script [minimal-demo.js](./minimal-demo.js) was adjusted to run interactively within a local (truffle/ganache) environment.\

The resulted script is [minimal-demo.local.js](./minimal-demo.local.js).

[Tornado Cash](./README.original.md) is a cool non-custodial Ethereum and ERC20 privacy solution based on zkSNARKs.

For review/tracing/debugging, the script imports some internal functions and variables of the original script:
```
  return {
    mixOnce,

    // Further entries exposed for educational purposes
    createDeposit,
    deposit,
    generateMerkleProof,
    generateSnarkProof,
    parseNote,
    pedersenHash,
    rbigint,
    toHex,
    withdraw,
    _getEvents,
    _getLeaves,
    _generateMerkleTree,

    getVars: () => ({
      circuit,
      contract,
      groth16,
      netId,
      proving_key
    })
  }
```

Usage example:
_(supposed to run interactively in truffle environment)_
```
 $ truffle develop
 truffle(develop)>
 // init
 compile
 migrate
 const t = await require('./minimal-demo.local')({ ETHTornado, accounts, web3 })

  // do deposit then withdraw
 await t.mixOnce()

 // do low-level calls
 const notes = []
 const doNDeposits = async (n = 5) => Promise.all(new Array(n).fill(0).map(() => new Promise(res => t.deposit().then(note => res(notes.push(note))))))
 await doNDeposits(7)
 console.log(notes)

 let events = await t._getEvents()
 let leaves = await t._getLeaves(events)
 let tree = t._generateMerkleTree(leaves)
 console.log(tree)

 let deposit4 = t.parseNote(notes[4])
 let path4 = tree.path(4)
 let resp = await t.generateSnarkProof(deposit4, accounts[4])
 let {proof, args} = resp
 let v = t.getVars()
 await v.contract.methods.withdraw(proof, ...args).send({from: accounts[2], gas: 1e6})
```
