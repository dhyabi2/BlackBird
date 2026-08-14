import { buildPoseidon } from 'circomlibjs';

let poseidon;
let F;

async function init() {
    poseidon = await buildPoseidon();
    F = poseidon.F;
}

function toBigInt(x) {
    if (typeof x === 'bigint') return x;
    return BigInt(String(x));
}

function poseidonHash(inputs) {
    const values = inputs.map(x => F.e(toBigInt(x).toString()));
    const out = poseidon(values);
    return toBigInt(F.toString(out));
}

function split32(hex) {
    const b = Buffer.from(hex.replace(/^0x/, ''), 'hex');
    if (b.length !== 32) throw new Error('split32 requires 32 bytes');
    const hi = BigInt('0x' + b.slice(0, 16).toString('hex'));
    const lo = BigInt('0x' + b.slice(16, 32).toString('hex'));
    return [lo, hi];
}

function buildSparseTree(leaves, depth) {
    // leaves are C values (field elements). Leaf hash = Poseidon(C, 0).
    let level = new Map();
    for (let i = 0; i < leaves.length; i++) {
        const h = poseidonHash([toBigInt(leaves[i]), 0n]);
        level.set(i, h);
    }
    const levels = [level];

    for (let d = 0; d < depth; d++) {
        const next = new Map();
        const parentSet = new Set();
        for (const idx of level.keys()) {
            parentSet.add(Math.floor(idx / 2));
        }
        for (const parent of parentSet) {
            const left = level.has(parent * 2) ? level.get(parent * 2) : 0n;
            const right = level.has(parent * 2 + 1) ? level.get(parent * 2 + 1) : 0n;
            next.set(parent, poseidonHash([left, right]));
        }
        levels.push(next);
        level = next;
    }

    const root = level.has(0) ? level.get(0) : 0n;
    return { root, levels };
}

function poseidonTree(leaves, depth, leafIndex) {
    const { root, levels } = buildSparseTree(leaves, depth);
    const path = [];
    const indices = [];
    let idx = leafIndex;
    for (let i = 0; i < depth; i++) {
        const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
        const sibling = levels[i].has(siblingIdx) ? levels[i].get(siblingIdx) : 0n;
        path.push(String(sibling));
        indices.push(idx % 2);
        idx = Math.floor(idx / 2);
    }
    return { root: String(root), path, indices };
}

async function main() {
    await init();
    const args = process.argv.slice(2);
    if (args[0] === 'hash') {
        let payload = '';
        process.stdin.on('data', chunk => payload += chunk);
        process.stdin.on('end', () => {
            try {
                const req = JSON.parse(payload);
                const h = poseidonHash(req.inputs.map(toBigInt));
                console.log(JSON.stringify({ hash: String(h) }));
            } catch (e) {
                console.log(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    if (args[0] === 'tree') {
        let payload = '';
        process.stdin.on('data', chunk => payload += chunk);
        process.stdin.on('end', () => {
            try {
                const req = JSON.parse(payload);
                const result = poseidonTree(
                    req.leaves.map(toBigInt),
                    req.depth,
                    req.leafIndex,
                );
                console.log(JSON.stringify(result));
            } catch (e) {
                console.log(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // CLI mode
    const leaves = args.map(a => BigInt('0x' + a));
    const result = poseidonTree(leaves, 20, 0);
    console.log(JSON.stringify(result, null, 2));
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
