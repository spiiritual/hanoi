import { createElement } from "react";
import type { ReactNode } from "react";

// oxlint-disable-next-line sonarjs/function-name -- Icon is the public React component name
export const Icon = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) =>
  createElement(
    "svg",
    {
      "aria-hidden": true,
      className,
      fill: "none",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: "2",
      viewBox: "0 0 24 24",
    },
    children
  );
