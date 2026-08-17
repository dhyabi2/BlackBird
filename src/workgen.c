/*
 * Nano proof-of-work generator.
 *
 * Usage: workgen <root_hex_64> <difficulty_hex_16>
 * Prints the 16-char big-endian hex work value on stdout.
 *
 * Implements BLAKE2b-8 per RFC 7693 over (work_le_8bytes || root_32bytes),
 * accepting the first nonce whose little-endian digest >= difficulty.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static const uint64_t blake2b_IV[8] = {
    0x6a09e667f3bcc908ULL, 0xbb67ae8584caa73bULL, 0x3c6ef372fe94f82bULL,
    0xa54ff53a5f1d36f1ULL, 0x510e527fade682d1ULL, 0x9b05688c2b3e6c1fULL,
    0x1f83d9abfb41bd6bULL, 0x5be0cd19137e2179ULL};

static const uint8_t blake2b_sigma[12][16] = {
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
    {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
    {11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4},
    {7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
    {9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13},
    {2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
    {12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11},
    {13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
    {6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5},
    {10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
    {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3}};

#define ROTR64(x, n) (((x) >> (n)) | ((x) << (64 - (n))))

#define G(r, i, a, b, c, d)                        \
    do {                                           \
        a = a + b + m[blake2b_sigma[r][2 * i]];    \
        d = ROTR64(d ^ a, 32);                     \
        c = c + d;                                 \
        b = ROTR64(b ^ c, 24);                     \
        a = a + b + m[blake2b_sigma[r][2 * i + 1]];\
        d = ROTR64(d ^ a, 16);                     \
        c = c + d;                                 \
        b = ROTR64(b ^ c, 63);                     \
    } while (0)

/* Single-block BLAKE2b with 8-byte digest over exactly 40 input bytes. */
static uint64_t blake2b8_40(const uint8_t block[128]) {
    uint64_t m[16];
    uint64_t v[16];
    uint64_t h0 = blake2b_IV[0] ^ 0x01010008ULL; /* depth=1, fanout=1, digest_length=8 */

    memcpy(m, block, 128);

    v[0] = h0;
    for (int i = 1; i < 8; i++) v[i] = blake2b_IV[i];
    for (int i = 0; i < 8; i++) v[8 + i] = blake2b_IV[i];
    v[12] ^= 40;                    /* t0 = bytes compressed */
    v[14] = ~v[14];                 /* final block flag */

    for (int r = 0; r < 12; r++) {
        G(r, 0, v[0], v[4], v[8], v[12]);
        G(r, 1, v[1], v[5], v[9], v[13]);
        G(r, 2, v[2], v[6], v[10], v[14]);
        G(r, 3, v[3], v[7], v[11], v[15]);
        G(r, 4, v[0], v[5], v[10], v[15]);
        G(r, 5, v[1], v[6], v[11], v[12]);
        G(r, 6, v[2], v[7], v[8], v[13]);
        G(r, 7, v[3], v[4], v[9], v[14]);
    }

    return h0 ^ v[0] ^ v[8]; /* little-endian u64 digest */
}

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int main(int argc, char **argv) {
    if (argc != 3 || strlen(argv[1]) != 64 || strlen(argv[2]) != 16) {
        fprintf(stderr, "usage: workgen <root_hex_64> <difficulty_hex_16>\n");
        return 2;
    }

    uint8_t root[32];
    for (int i = 0; i < 32; i++) {
        int hi = hexval(argv[1][2 * i]), lo = hexval(argv[1][2 * i + 1]);
        if (hi < 0 || lo < 0) { fprintf(stderr, "bad root hex\n"); return 2; }
        root[i] = (uint8_t)(hi << 4 | lo);
    }
    uint64_t difficulty = strtoull(argv[2], NULL, 16);

    uint8_t block[128];
    memset(block, 0, sizeof(block));
    memcpy(block + 8, root, 32);

    /* Random start to avoid duplicate nonces across runs. */
    uint64_t nonce;
    {
        FILE *ur = fopen("/dev/urandom", "rb");
        if (!ur || fread(&nonce, sizeof(nonce), 1, ur) != 1) nonce = (uint64_t)time(NULL) * 2654435761ULL;
        if (ur) fclose(ur);
    }

    for (;;) {
        memcpy(block, &nonce, 8); /* little-endian on x86 */
        if (blake2b8_40(block) >= difficulty) {
            /* Print big-endian hex of the nonce (standard Nano work format). */
            printf("%016llx\n", (unsigned long long)nonce);
            return 0;
        }
        nonce++;
    }
}
