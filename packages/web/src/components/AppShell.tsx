import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Sidebar, TopNav, Tabs } from "@theokit/ui";
import { CommandPalette } from "./CommandPalette.js";
import { DateRangePicker } from "./DateRangePicker.js";
import { SpanQueryToolbar } from "./SpanQueryToolbar.js";
import {
  ListTree,
  Layers,
  LayoutDashboard,
  Wrench,
  DollarSign,
  type LucideIcon,
} from "lucide-react";

/** Primary product nav (left sidebar) — every route is reachable here. */
const NAV: { label: string; path: string; icon: LucideIcon }[] = [
  { label: "Executions", path: "/", icon: ListTree },
  { label: "Sessions", path: "/sessions", icon: Layers },
  // M20: Dashboards is the unified metrics home (Pinned Charts + re-homed north-star).
  { label: "Dashboards", path: "/dashboards", icon: LayoutDashboard },
  { label: "Tools", path: "/tools", icon: Wrench },
  { label: "Cost", path: "/analytics", icon: DollarSign },
];

/**
 * Arize-style per-project view tabs. Traces is the live executions view (M3);
 * Spans / Agent Graph / Agent Path are placeholders until their milestone
 * (M18 / M21) — the tab bar shows the full information architecture up front.
 */
const TABS: { value: string; label: string; path: string }[] = [
  { value: "traces", label: "Traces", path: "/" },
  { value: "spans", label: "Spans", path: "/spans" },
  { value: "agent-graph", label: "Agent Graph", path: "/agent-graph" },
  { value: "agent-path", label: "Agent Path", path: "/agent-path" },
];

function navIsActive(pathname: string, navPath: string): boolean {
  if (navPath === "/") {
    return pathname === "/" || pathname.startsWith("/traces");
  }
  return pathname === navPath || pathname.startsWith(`${navPath}/`);
}

/** Longest-prefix match of the current path to a project-view tab (or "" if none). */
function tabForPath(pathname: string): string {
  if (pathname === "/" || pathname.startsWith("/traces")) return "traces";
  const hit = TABS.find(
    (t) => t.path !== "/" && pathname.startsWith(t.path),
  );
  return hit ? hit.value : "";
}

/**
 * The persistent app chrome: a left Sidebar (product nav), a TopNav (title +
 * an actions slot), the Arize project-view Tabs, and the routed content via
 * React Router's <Outlet/>. Built entirely from @theokit/ui primitives.
 */
export function AppShell() {
  const loc = useLocation();
  const navigate = useNavigate();
  const activeTab = tabForPath(loc.pathname);

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Global Cmd/Ctrl+K command palette (portal — mount once at the shell root). */}
      <CommandPalette />
      <Sidebar role="navigation" aria-label="Primary">
        <Sidebar.Header>
          <span className="text-title-md font-display">Theo Lens</span>
        </Sidebar.Header>
        <Sidebar.Section title="Observability">
          {NAV.map((item) => (
            <Sidebar.Item
              key={item.path}
              icon={item.icon}
              active={navIsActive(loc.pathname, item.path)}
              aria-current={navIsActive(loc.pathname, item.path) ? "page" : undefined}
              onClick={() => navigate(item.path)}
            >
              {item.label}
            </Sidebar.Item>
          ))}
        </Sidebar.Section>
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopNav>
          <TopNav.Left>
            <span className="text-label font-display">Theo Lens</span>
          </TopNav.Left>
          <TopNav.Right>
            <DateRangePicker />
          </TopNav.Right>
        </TopNav>

        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            const tab = TABS.find((t) => t.value === value);
            if (tab) navigate(tab.path);
          }}
        >
          <Tabs.List>
            {TABS.map((tab) => (
              <Tabs.Trigger key={tab.value} value={tab.value}>
                {tab.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </Tabs>

        {/* M30b: the shared span-query spine — one bar + structured builder driving every
            project-view tab. Hidden on non-tab routes (Sessions/Dashboards/Tools/Cost). */}
        {activeTab !== "" && <SpanQueryToolbar />}

        <main className="flex-1 overflow-auto p-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
