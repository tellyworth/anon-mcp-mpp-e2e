#!/usr/bin/env node
/*
 * End-to-end test for the anonymous paid MCP route (POST /mcp/public).
 *
 * Flow:
 *   1. initialize MCP session                          -> Mcp-Session-Id
 *   2. tools/call quick_upload (no credential)         -> JSON-RPC -32042 + challenge
 *   3. send USDC transfer to challenge.recipient       (Base Sepolia)
 *   4. tools/call quick_upload with the credential     -> success + receipt meta
 *
 * Required env:
 *   WALLET_PRIVATE_KEY   0x-prefixed hex; must hold Base Sepolia testnet ETH (gas)
 *                        and testnet USDC at the contract reported in the challenge.
 *
 * Optional env:
 *   MCP_URL              default: https://api.stage-cloudup.com/mcp/public
 *   RPC_URL              default: https://sepolia.base.org
 *   HTTPS_PROXY          e.g. socks5h://127.0.0.1:8080 (stage routes go via SOCKS).
 *                        If unset, the script probes 127.0.0.1:8080 and uses it
 *                        automatically when a SOCKS5 proxy is listening.
 *   IMAGE_FILE           path to image to upload; default: ./sample.jpg
 *                        supports .jpg/.jpeg/.png/.gif/.webp
 *
 * Usage:
 *   npm install
 *   WALLET_PRIVATE_KEY=0x... npm test
 */

import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import {
	createWalletClient,
	createPublicClient,
	http,
	encodeFunctionData,
	parseUnits,
	getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';

const MCP_URL = process.env.MCP_URL ?? 'https://api.stage-cloudup.com/mcp/public';
const RPC_URL = process.env.RPC_URL ?? 'https://sepolia.base.org';
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
const DEFAULT_PROXY = 'socks5h://127.0.0.1:8080';

function probeTcp(host, port, timeoutMs = 500) {
	return new Promise((resolve) => {
		const sock = connect({ host, port });
		let settled = false;
		const finish = (ok) => {
			if (settled) return;
			settled = true;
			sock.destroy();
			resolve(ok);
		};
		sock.once('connect', () => finish(true));
		sock.once('error', () => finish(false));
		setTimeout(() => finish(false), timeoutMs);
	});
}

async function resolveProxy() {
	const explicit =
		process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
	if (explicit) return { url: explicit, source: 'env' };
	if (await probeTcp('127.0.0.1', 8080)) return { url: DEFAULT_PROXY, source: 'probe' };
	return { url: undefined, source: 'none' };
}

if (!PRIVATE_KEY) {
	console.error('WALLET_PRIVATE_KEY is required (0x-prefixed hex).');
	process.exit(1);
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const IMAGE_FILE = resolve(SCRIPT_DIR, process.env.IMAGE_FILE ?? 'sample.jpg');

const MIME_BY_EXT = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
};

function loadImage(path) {
	const ext = extname(path).toLowerCase();
	const mime = MIME_BY_EXT[ext];
	if (!mime) throw new Error(`unsupported image extension: ${ext}`);
	const bytes = readFileSync(path);
	return {
		filename: basename(path),
		mime,
		content_base64: bytes.toString('base64'),
		size: bytes.length,
	};
}

const ERC20_TRANSFER_ABI = [
	{
		type: 'function',
		name: 'transfer',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'to', type: 'address' },
			{ name: 'value', type: 'uint256' },
		],
		outputs: [{ name: '', type: 'bool' }],
	},
];

function createMcpClient(proxyUrl) {
	const proxyAgent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined;
	return axios.create({
		baseURL: MCP_URL,
		httpsAgent: proxyAgent,
		httpAgent: proxyAgent,
		proxy: false,
		timeout: 30_000,
		validateStatus: () => true,
		headers: {
			Accept: 'application/json, text/event-stream',
			'Content-Type': 'application/json',
		},
	});
}

async function rpc(mcp, body, headers = {}) {
	const r = await mcp.post('', body, { headers });
	return { status: r.status, headers: r.headers, body: r.data };
}

async function initSession(mcp) {
	const init = await rpc(mcp, {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'mpp-e2e', version: '0.1' },
		},
	});
	if (init.status !== 200) {
		throw new Error(`initialize HTTP ${init.status}: ${JSON.stringify(init.body)}`);
	}
	const sid = init.headers['mcp-session-id'];
	if (!sid) throw new Error('no Mcp-Session-Id returned');

	const ack = await rpc(
		mcp,
		{ jsonrpc: '2.0', method: 'notifications/initialized' },
		{ 'Mcp-Session-Id': sid },
	);
	if (ack.status !== 202) {
		throw new Error(`notifications/initialized HTTP ${ack.status}`);
	}
	return sid;
}

async function callTool(mcp, sid, name, args, meta) {
	const params = { name, arguments: args };
	if (meta) params._meta = meta;
	const r = await rpc(
		mcp,
		{ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params },
		{ 'Mcp-Session-Id': sid },
	);
	if (r.status !== 200) {
		throw new Error(`tools/call HTTP ${r.status}: ${JSON.stringify(r.body)}`);
	}
	return r.body;
}

async function main() {
	const account = privateKeyToAccount(PRIVATE_KEY);
	const image = loadImage(IMAGE_FILE);
	const proxy = await resolveProxy();
	const mcp = createMcpClient(proxy.url);

	console.log(`wallet         ${account.address}`);
	console.log(`mcp            ${MCP_URL}`);
	console.log(`rpc            ${RPC_URL}`);
	if (proxy.url) {
		console.log(`proxy          ${proxy.url}${proxy.source === 'probe' ? ' (auto-detected)' : ''}`);
	}
	console.log(`image          ${IMAGE_FILE} (${image.mime}, ${image.size} bytes)`);

	console.log('\n[1] initialize MCP session');
	const sid = await initSession(mcp);
	console.log(`    session    ${sid}`);

	console.log('\n[2] quick_upload (no credential) -> expect -32042');
	const args = {
		filename: image.filename,
		content_base64: image.content_base64,
		mime: image.mime,
	};
	const challengeRes = await callTool(mcp, sid, 'quick_upload', args);
	if (!challengeRes.error || challengeRes.error.code !== -32042) {
		throw new Error(`expected -32042, got: ${JSON.stringify(challengeRes)}`);
	}
	const challenge = challengeRes.error.data.challenges[0];
	const method = challenge.methods[0];
	console.log(`    challenge  ${challenge.challenge_id}`);
	console.log(`    sku        ${challenge.sku}  amount ${challenge.amount} ${method.currency}`);
	console.log(`    network    ${method.network}`);
	console.log(`    contract   ${method.currency_contract}`);
	console.log(`    recipient  ${method.recipient_address}`);

	console.log('\n[3] send USDC transfer on Base Sepolia');
	const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC_URL) });
	const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
	const value = parseUnits(challenge.amount, method.currency_decimals);
	const data = encodeFunctionData({
		abi: ERC20_TRANSFER_ABI,
		functionName: 'transfer',
		args: [getAddress(method.recipient_address), value],
	});
	const txHash = await wallet.sendTransaction({
		to: getAddress(method.currency_contract),
		data,
	});
	console.log(`    tx         ${txHash}`);
	const rcpt = await pub.waitForTransactionReceipt({ hash: txHash });
	if (rcpt.status !== 'success') {
		throw new Error(`transfer not successful: status=${rcpt.status}`);
	}
	console.log(`    confirmed  block ${rcpt.blockNumber}`);

	console.log('\n[4] quick_upload with credential');
	const credential = {
		method: method.id,
		challenge_id: challenge.challenge_id,
		opaque: challenge.opaque,
		settlement_tx_hash: txHash,
	};
	const okRes = await callTool(mcp, sid, 'quick_upload', args, {
		'org.paymentauth/credential': credential,
	});
	if (okRes.error) {
		throw new Error(`quick_upload failed: ${JSON.stringify(okRes.error)}`);
	}

	const upload = parseUploadResult(okRes.result);
	console.log('    upload');
	console.log(`        item_id    ${upload.item_id ?? '(missing)'}`);
	console.log(`        share_url  ${upload.share_url ?? '(missing)'}`);
	console.log(`        direct_url ${upload.direct_url ?? '(missing)'}`);
	if (upload.delete_url) console.log(`        delete_url ${upload.delete_url}`);

	const receipt = okRes.result?._meta?.['org.paymentauth/receipt'];
	if (!receipt) {
		console.warn('\nwarning: no org.paymentauth/receipt in result._meta');
	} else {
		console.log('\n    receipt');
		console.log(`        sku        ${receipt.sku}`);
		console.log(`        amount     ${receipt.amount} (settlement ${receipt.settlement})`);
		console.log(`        issued     ${new Date(receipt.issued_at * 1000).toISOString()}`);
		console.log(`        mac        ${receipt.mac?.slice(0, 16)}...`);
	}
	console.log('\nOK');
}

function parseUploadResult(result) {
	const text = result?.content?.find((c) => c?.type === 'text')?.text;
	if (typeof text !== 'string') return {};
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === 'object' && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

main().catch((e) => {
	console.error(`\nFAILED: ${e.message}`);
	process.exit(1);
});
