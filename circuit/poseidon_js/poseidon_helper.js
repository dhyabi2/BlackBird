const { buildPoseidon } = require('circomlibjs');

const BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function toHex32(n) {
    return '0x' + n.toString(16).padStart(64, '0');
}

function split32(b) {
    const n = BigInt('0x' + Buffer.from(b).toString('hex'));
    const lo = n & ((1n << 128n) - 1n);
    const hi = n >> 128n;
    return [lo, hi];
}

function poseidonTree(poseidon, leaves, depth) {
    const zeroLeaf = poseidon.F.e(0);
    const size = 2 ** depth;
    const padded = leaves.slice();
    while (padded.length < size) padded.push(zeroLeaf);

    const levels = [padded.map(x => poseidon.F.e(x))];
    for (let i = 0; i < depth; i++) {
        const next = [];
        const current = levels[i];
        for (let j = 0; j < current.length; j += 2) {
            const left = current[j];
            const right = current[j + 1] || zeroLeaf;
            next.push(poseidon([left, right]));
        }
        levels.push(next);
    }

    const root = levels[depth][0];
    return { root, levels };
}

function getProof(poseidon, levels, depth, leafIndex) {
    let idx = leafIndex;
    const path = [];
    const indices = [];
    for (let i = 0; i < depth; i++) {
        const siblingIdx = idx ^ 1;
        const sibling = levels[i][siblingIdx] || poseidon.F.e(0);
        path.push(poseidon.F.toString(sibling));
        indices.push(idx % 2);
        idx = Math.floor(idx / 2);
    }
    return { path, indices };
}

async function main() {
    const poseidon = await buildPoseidon();

    let inputData = '';
    process.stdin.on('data', chunk => inputData += chunk);
    process.stdin.on('end', () => {
        try {
            const req = JSON.parse(inputData);
            const { action } = req;

            if (action === 'hash') {
                const inputs = req.inputs.map(x => poseidon.F.e(BigInt(x)));
                const h = poseidon(inputs);
                console.log(JSON.stringify({ hash: poseidon.F.toString(h) }));
            } else if (action === 'tree') {
                const leaves = req.leaves.map(x => poseidon.F.e(BigInt(x)));
                const depth = req.depth || 20;
                const { root, levels } = poseidonTree(poseidon, leaves, depth);
                const leafIndex = req.leafIndex;
                const result = { root: poseidon.F.toString(root) };
                if (leafIndex !== undefined) {
                    const proof = getProof(poseidon, levels, depth, leafIndex);
                    result.path = proof.path;
                    result.indices = proof.indices;
                }
                console.log(JSON.stringify(result));
            } else if (action === 'verify_proof') {
                const leaf = poseidon.F.e(BigInt(req.leaf));
                const path = req.path.map(x => poseidon.F.e(BigInt(x)));
                const indices = req.indices;
                let current = leaf;
                for (let i = 0; i < path.length; i++) {
                    const sibling = path[i];
                    if (indices[i] === 0) {
                        current = poseidon([current, sibling]);
                    } else {
                        current = poseidon([sibling, current]);
                    }
                }
                console.log(JSON.stringify({ root: poseidon.F.toString(current) }));
            } else {
                console.log(JSON.stringify({ error: 'unknown action' }));
            }
        } catch (e) {
            console.log(JSON.stringify({ error: e.message }));
        }
    });
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
