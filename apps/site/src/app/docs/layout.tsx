import type { ReactNode } from "react";
import { DocsSidebar } from "@/components/DocsSidebar";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="section-light section">
      <div className="container">
        <div className="docs-shell">
          <aside className="docs-aside">
            <DocsSidebar />
          </aside>
          <div className="docs-main">{children}</div>
        </div>
      </div>
    </div>
  );
}
