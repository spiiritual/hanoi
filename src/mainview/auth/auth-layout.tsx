import type { ReactNode } from "react";

export const AuthLayout = ({
  children,
  className = "auth-inner",
}: {
  children: ReactNode;
  className?: "auth-inner" | "welcome-inner";
}) => <div className={className}>{children}</div>;

export const AuthSpacer = ({ height }: { height: number }) => (
  <div className={`spacer spacer-${height}`} />
);
