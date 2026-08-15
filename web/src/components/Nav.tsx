"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Home" },
  { href: "/easy", label: "Easy" },
  { href: "/wallet", label: "Wallet" },
  { href: "/deposit", label: "Deposit" },
  { href: "/withdraw", label: "Withdraw" },
  { href: "/status", label: "Status" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        <Link href="/" className="text-xl font-bold tracking-tight">
          VELA <span className="text-emerald-400">v2</span>
        </Link>
        <ul className="flex gap-6 text-sm font-medium">
          {links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className={`transition-colors hover:text-emerald-400 ${
                  pathname === link.href ? "text-emerald-400" : "text-zinc-400"
                }`}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
