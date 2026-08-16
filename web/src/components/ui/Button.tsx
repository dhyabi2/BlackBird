import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center rounded-lg px-4 py-3 font-semibold transition-colors disabled:opacity-50";
  const styles = {
    primary: "bg-black text-white hover:bg-black/80",
    secondary: "border border-black/20 bg-white text-black hover:bg-black/5",
    ghost: "bg-transparent text-black hover:bg-black/5",
  };

  return (
    <button
      className={`${base} ${styles[variant]} ${className}`}
      {...props}
    />
  );
}
