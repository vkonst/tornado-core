// Note usage example in the end of this file
const fs = require('fs')
const assert = require('assert')
const { bigInt } = require('snarkjs')
const crypto = require('crypto')
const circomlib = require('circomlib')
const merkleTree = require('./lib/MerkleTree')
const buildGroth16 = require('websnark/src/groth16')
const websnarkUtils = require('websnark/src/utils')
const { toWei } = require('web3-utils')

let accounts, ETHTornado, web3
let contract, netId, circuit, proving_key, groth16

module.exports = async ({ ETHTornado: e, accounts: a, web3: w } = {}) => {
  ETHTornado = global.ETHTornado ? global.ETHTornado : e
  accounts = global.accounts ? global.accounts : a
  web3 = global.web3 ? global.web3 : w

  await main()

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
}

const MERKLE_TREE_HEIGHT = 20
const AMOUNT = '0.1'
// CURRENCY = 'ETH'

/** Generate random number of specified byte length */
const rbigint = nbytes => bigInt.leBuff2int(crypto.randomBytes(nbytes))

/** Compute pedersen hash */
const pedersenHash = data => circomlib.babyJub.unpackPoint(circomlib.pedersenHash.hash(data))[0]

/** BigNumber to hex string of specified length */
const toHex = (number, length = 32) => '0x' + (number instanceof Buffer ? number.toString('hex') : bigInt(number).toString(16)).padStart(length * 2, '0')

/**
 * Create deposit object from secret and nullifier
 */
function createDeposit(nullifier, secret) {
  let deposit = { nullifier, secret }
  deposit.preimage = Buffer.concat([deposit.nullifier.leInt2Buff(31), deposit.secret.leInt2Buff(31)])
  deposit.commitment = pedersenHash(deposit.preimage)
  deposit.nullifierHash = pedersenHash(deposit.nullifier.leInt2Buff(31))
  return deposit
}

/**
 * Make an ETH deposit
 */
async function deposit() {
  const deposit = createDeposit(rbigint(31), rbigint(31))
  console.log('Sending deposit transaction...')
  const tx = await contract.methods.deposit(toHex(deposit.commitment)).send({ value: toWei(AMOUNT), from: web3.eth.defaultAccount, gas:2e6 })
  console.log(`txHash: ${tx.transactionHash}`)
  return `tornado-eth-${AMOUNT}-${netId}-${toHex(deposit.preimage, 62)}`
}

/**
 * Do an ETH withdrawal
 * @param note Note to withdraw
 * @param recipient Recipient address
 */
async function withdraw(note, recipient) {
  const deposit = parseNote(note)
  const { proof, args } = await generateSnarkProof(deposit, recipient)
  console.log('Sending withdrawal transaction...')
  const tx = await contract.methods.withdraw(proof, ...args).send({ from: web3.eth.defaultAccount, gas: 1e6 })
  console.log(`txHash: ${tx.transactionHash}`)
}

/**
 * Parses Tornado.cash note
 * @param noteString the note
 */
function parseNote(noteString) {
  const noteRegex = /tornado-(?<currency>\w+)-(?<amount>[\d.]+)-(?<netId>\d+)-0x(?<note>[0-9a-fA-F]{124})/g
  const match = noteRegex.exec(noteString)

  // we are ignoring `currency`, `amount`, and `netId` for this minimal example
  const buf = Buffer.from(match.groups.note, 'hex')
  const nullifier = bigInt.leBuff2int(buf.slice(0, 31))
  const secret = bigInt.leBuff2int(buf.slice(31, 62))
  return createDeposit(nullifier, secret)
}

/**
 * Generate merkle tree for a deposit.
 * Download deposit events from the contract, reconstructs merkle tree, finds our deposit leaf
 * in it and generates merkle proof
 * @param deposit Deposit object
 */
async function generateMerkleProof(deposit) {
  const events = await _getEvents()
  const leaves = _getLeaves(events)
  const tree = _generateMerkleTree(leaves)

  // Find current commitment in the tree
  let depositEvent = events.find(e => e.returnValues.commitment === toHex(deposit.commitment))
  let leafIndex = depositEvent ? depositEvent.returnValues.leafIndex : -1

  // Validate that our data is correct (optional)
  const isValidRoot = await contract.methods.isKnownRoot(toHex(await tree.root())).call()
  const isSpent = await contract.methods.isSpent(toHex(deposit.nullifierHash)).call()
  assert(isValidRoot === true, 'Merkle tree is corrupted')
  assert(isSpent === false, 'The note is already spent')
  assert(leafIndex >= 0, 'The deposit is not found in the tree')

  // Compute merkle proof of our commitment
  return await tree.path(leafIndex)
}

async function _getEvents() {
  console.log('Getting contract state...')
  return await contract.getPastEvents('Deposit', { fromBlock: 0, toBlock: 'latest' })
}

function _getLeaves(events) {
  return events
    .sort((a, b) => a.returnValues.leafIndex - b.returnValues.leafIndex) // Sort events in chronological order
    .map(e => e.returnValues.commitment)
}

function _generateMerkleTree(leaves) {
  return new merkleTree(MERKLE_TREE_HEIGHT, leaves)
}

/**
 * Generate SNARK proof for withdrawal
 * @param deposit Deposit object
 * @param recipient Funds recipient
 */
async function generateSnarkProof(deposit, recipient) {
  // Compute merkle proof of our commitment
  const { root, path_elements, path_index } = await generateMerkleProof(deposit)

  // Prepare circuit input
  const input = {
    // Public snark inputs
    root: root,
    nullifierHash: deposit.nullifierHash,
    recipient: bigInt(recipient),
    relayer: 0,
    fee: 0,
    refund: 0,

    // Private snark inputs
    nullifier: deposit.nullifier,
    secret: deposit.secret,
    pathElements: path_elements,
    pathIndices: path_index,
  }

  console.log('Generating SNARK proof...')
  const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, proving_key)
  const { proof } = websnarkUtils.toSolidityInput(proofData)

  const args = [
    toHex(input.root),
    toHex(input.nullifierHash),
    toHex(input.recipient, 20),
    toHex(input.relayer, 20),
    toHex(input.fee),
    toHex(input.refund)
  ]

  return { proof, args }
}

async function mixOnce() {
  const note = await deposit()
  console.log('Deposited note:', note)
  await withdraw(note, web3.eth.defaultAccount)
  console.log('Done')
}

async function main() {
  circuit = require('./build/circuits/withdraw.json')
  proving_key = fs.readFileSync('build/circuits/withdraw_proving_key.bin').buffer
  groth16 = await buildGroth16()
  netId = await web3.eth.net.getId()
  contract = new web3.eth.Contract(ETHTornado.abi, ETHTornado.address)
  // eslint-disable-next-line require-atomic-updates
  if (!web3.eth.defaultAccount) web3.eth.defaultAccount = accounts[0]
}

/* Supposed to run in truffle environment:
 truffle(develop)>
 // init
 compile
 migrate
 const t = await require('./minimal-demo.local')({ ETHTornado, accounts, web3 })

  // do deposit then withdraw
 await t.mixOnce()

 // low-level
 const notes = []
 const doNDeposits = async (n = 5) => Promise.all(new Array(n).fill(0).map(() => new Promise(res => t.deposit().then(note => res(notes.push(note))))))
 await doNDeposits(7)
 let events = await t._getEvents()
 let leaves = await t._getLeaves(events)
 let tree = t._generateMerkleTree(leaves)
 let deposit4 = t.parseNote(notes[4])
 let path4 = tree.path(4)
 let resp = await t.generateSnarkProof(deposit4, accounts[4])
 let {proof, args} = resp
 let v = t.getVars()
 await v.contract.methods.withdraw(proof, ...args).send({from: accounts[2], gas: 1e6})
*/
