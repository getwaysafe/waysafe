import type { ReactNode } from "react";
import "./film.css";

export const metadata = { title: "Waysafe -- the control isn't in the agent" };

export default function FilmLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
