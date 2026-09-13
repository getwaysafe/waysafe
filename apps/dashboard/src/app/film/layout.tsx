import type { ReactNode } from "react";
import { Bricolage_Grotesque, DM_Sans, JetBrains_Mono } from "next/font/google";
import "./film.css";

export const metadata = { title: "Waysafe -- the control isn't in the agent" };

/** D-45: the storyboard's own three families (`design/film-storyboard/
 * README.md`), loaded via `next/font/google` rather than the storyboard's
 * own <link> tag -- same fonts, self-hosted at build time instead of
 * fetched from Google at request time. `film.css` references these by the
 * CSS variables below with the storyboard's own fallback stacks. */
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-bricolage",
});
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-dm-sans",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains-mono",
});

export default function FilmLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`${bricolage.variable} ${dmSans.variable} ${jetbrainsMono.variable}`}>
      {children}
    </div>
  );
}
