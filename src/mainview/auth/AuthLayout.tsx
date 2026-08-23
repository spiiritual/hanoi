import type { ReactNode } from "react";

export function AuthLayout({
  children,
  className = "auth-inner",
}: {
  children: ReactNode;
  className?: "auth-inner" | "welcome-inner";
}) {
  return <div className={className}>{children}</div>;
}

export function AuthSpacer({ height }: { height: number }) {
  return <div className={`spacer spacer-${height}`} />;
}
