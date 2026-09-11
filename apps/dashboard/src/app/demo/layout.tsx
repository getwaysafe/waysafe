import type { ReactNode } from "react";
import "./demo.css";

export const metadata = { title: "Waysafe -- live demo" };

export default function DemoLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
