pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

// VELA v2 deposit/withdrawal circuit (prototype).
// Public inputs:  root, nullifier, P_w (encoded as two field elements)
// Private inputs: n (nullifier secret), t (trapdoor), S_pub (source pubkey),
//                 leafIndex[DEPTH], path[DEPTH]

template VelaWithdraw(DEPTH) {
    signal input root;
    signal input nullifier;
    signal input P_w_lo;
    signal input P_w_hi;

    signal input n_lo;
    signal input n_hi;
    signal input t_lo;
    signal input t_hi;
    signal input S_pub_lo;
    signal input S_pub_hi;
    signal input leafIndex[DEPTH];
    signal input path[DEPTH];

    var DOMAIN_DEPOSIT = 1;
    var DOMAIN_NULL = 2;

    // 1. Commitment C = Poseidon(DOMAIN_DEPOSIT, n, t, P_w, S_pub)
    component commitment = Poseidon(9);
    commitment.inputs[0] <== DOMAIN_DEPOSIT;
    commitment.inputs[1] <== n_lo;
    commitment.inputs[2] <== n_hi;
    commitment.inputs[3] <== t_lo;
    commitment.inputs[4] <== t_hi;
    commitment.inputs[5] <== P_w_lo;
    commitment.inputs[6] <== P_w_hi;
    commitment.inputs[7] <== S_pub_lo;
    commitment.inputs[8] <== S_pub_hi;

    // 2. Nullifier N = Poseidon(DOMAIN_NULL, n)
    component nullifierHash = Poseidon(3);
    nullifierHash.inputs[0] <== DOMAIN_NULL;
    nullifierHash.inputs[1] <== n_lo;
    nullifierHash.inputs[2] <== n_hi;
    nullifier === nullifierHash.out;

    // 3. Merkle membership of C
    component leafHash = Poseidon(2);
    leafHash.inputs[0] <== commitment.out;
    leafHash.inputs[1] <== 0;

    component merkle[DEPTH];
    component leftMux[DEPTH];
    component rightMux[DEPTH];
    signal current[DEPTH + 1];
    current[0] <== leafHash.out;

    for (var i = 0; i < DEPTH; i++) {
        // If leafIndex[i] == 0: current is left, path is right
        // If leafIndex[i] == 1: path is left, current is right
        leftMux[i] = Mux1();
        leftMux[i].c[0] <== current[i];
        leftMux[i].c[1] <== path[i];
        leftMux[i].s <== leafIndex[i];

        rightMux[i] = Mux1();
        rightMux[i].c[0] <== path[i];
        rightMux[i].c[1] <== current[i];
        rightMux[i].s <== leafIndex[i];

        merkle[i] = Poseidon(2);
        merkle[i].inputs[0] <== leftMux[i].out;
        merkle[i].inputs[1] <== rightMux[i].out;
        current[i + 1] <== merkle[i].out;
    }

    root === current[DEPTH];
}

component main {public [root, nullifier, P_w_lo, P_w_hi]} = VelaWithdraw(20);
