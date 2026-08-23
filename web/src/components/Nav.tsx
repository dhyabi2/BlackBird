"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Send" },
  { href: "/status", label: "Status" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="border-b border-black/10 bg-white">
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-3 px-4 py-4 sm:flex-row sm:justify-between sm:gap-0">
        <Link href="/" className="flex items-center gap-2.5">
          <img src="/icon.png" alt="BlackBird" className="h-9 w-auto" />
          <span className="flex flex-col leading-tight">
            <span className="text-xl font-bold tracking-tight">BlackBird</span>
            <span className="text-xs font-medium text-black/50">Send XNO Privately</span>
          </span>
        </Link>
        <ul className="flex flex-wrap justify-center gap-4 text-sm font-medium sm:gap-6">
          {links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className={`transition-colors hover:text-black ${
                  pathname === link.href ? "text-black" : "text-black/50"
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
