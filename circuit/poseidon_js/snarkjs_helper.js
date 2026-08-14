const snarkjs = require('snarkjs');
const fs = require('fs');
const path = require('path');

const BASE_DIR = process.env.BASE_DIR || path.join(__dirname, '..', 'build');

async function main() {
    let inputData = '';
    process.stdin.on('data', chunk => inputData += chunk);
    process.stdin.on('end', async () => {
        try {
            const req = JSON.parse(inputData);
            const { action } = req;

            if (action === 'prove') {
                const wasmPath = path.join(BASE_DIR, 'vela_js', 'vela.wasm');
                const zkeyPath = path.join(BASE_DIR, 'vela_final.zkey');
                const input = req.input;
                const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
                console.log(JSON.stringify({ proof, publicSignals }));
            } else if (action === 'verify') {
                const vkPath = path.join(BASE_DIR, 'verification_key.json');
                const vKey = JSON.parse(fs.readFileSync(vkPath, 'utf8'));
                const valid = await snarkjs.groth16.verify(vKey, req.publicSignals, req.proof);
                console.log(JSON.stringify({ valid }));
            } else {
                console.log(JSON.stringify({ error: 'unknown action' }));
            }
        } catch (e) {
            console.log(JSON.stringify({ error: e.message, stack: e.stack }));
        } finally {
            process.exit(0);
        }
    });
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
