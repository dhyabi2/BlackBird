#!/usr/bin/env python3
"""Pure-Python ed25519-blake2b (Nano) signature verifier.

Reads JSON lines {"pub": hex32, "msg": hex, "sig": hex64, "expect": bool}
from stdin; exits non-zero on the first vector whose verification result
disagrees with "expect". Shares no code with the Rust implementation —
independent field/point arithmetic from the ed25519 definition.
"""
import hashlib
import json
import sys

p = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
d = (-121665 * pow(121666, p - 2, p)) % p


def inv(x):
    return pow(x, p - 2, p)


def recover_x(y, sign):
    if y >= p:
        return None
    x2 = (y * y - 1) * inv(d * y * y + 1) % p
    if x2 == 0:
        if sign:
            return None
        return 0
    x = pow(x2, (p + 3) // 8, p)
    if (x * x - x2) % p != 0:
        x = x * pow(2, (p - 1) // 4, p) % p
    if (x * x - x2) % p != 0:
        return None
    if (x & 1) != sign:
        x = p - x
    return x


def decompress(b):
    y = int.from_bytes(b, "little") & ((1 << 255) - 1)
    sign = b[31] >> 7
    x = recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % p)


def edwards_add(P, Q):
    x1, y1, z1, t1 = P
    x2, y2, z2, t2 = Q
    a = (y1 - x1) * (y2 - x2) % p
    b = (y1 + x1) * (y2 + x2) % p
    c = 2 * t1 * t2 * d % p
    dd = 2 * z1 * z2 % p
    e, f, g, h = b - a, dd - c, dd + c, b + a
    return (e * f % p, g * h % p, f * g % p, e * h % p)


def scalar_mult(s, P):
    Q = (0, 1, 1, 0)  # identity
    while s > 0:
        if s & 1:
            Q = edwards_add(Q, P)
        P = edwards_add(P, P)
        s >>= 1
    return Q


def equal(P, Q):
    x1, y1, z1, _ = P
    x2, y2, z2, _ = Q
    return (x1 * z2 - x2 * z1) % p == 0 and (y1 * z2 - y2 * z1) % p == 0


By = 4 * inv(5) % p
Bx = recover_x(By, 0)
B = (Bx, By, 1, Bx * By % p)


def verify(pub, msg, sig):
    A = decompress(pub)
    if A is None:
        return False
    R = decompress(sig[:32])
    if R is None:
        return False
    s = int.from_bytes(sig[32:], "little")
    if s >= L:
        return False
    h = hashlib.blake2b(digest_size=64)
    h.update(sig[:32])
    h.update(pub)
    h.update(msg)
    c = int.from_bytes(h.digest(), "little") % L
    return equal(scalar_mult(s, B), edwards_add(R, scalar_mult(c, A)))


def main():
    n = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        v = json.loads(line)
        got = verify(
            bytes.fromhex(v["pub"]), bytes.fromhex(v["msg"]), bytes.fromhex(v["sig"])
        )
        if got != v["expect"]:
            print(f"MISMATCH at vector {n}: expected {v['expect']}, got {got}")
            sys.exit(1)
        n += 1
    print(f"OK {n}")


if __name__ == "__main__":
    main()
