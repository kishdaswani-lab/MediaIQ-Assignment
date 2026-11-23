"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

const destinations = [
  { href: "/", label: "Overview", icon: GridIcon },
  { href: "/upload", label: "Upload", icon: UploadIcon },
  { href: "/performance", label: "Performance", icon: ChartIcon },
  { href: "/commercial", label: "Commercial", icon: CoinIcon },
  { href: "/audience", label: "Audience", icon: PeopleIcon },
  { href: "/cross-media", label: "Cross-Media", icon: LayersIcon },
  { href: "/intelligence", label: "Intelligence", icon: SparkIcon },
  { href: "/planner", label: "Media Planner", icon: CompassIcon },
  { href: "/reports", label: "Reports", icon: DocumentIcon },
  { href: "/settings", label: "Settings", icon: GearIcon },
  { href: "/reservations", label: "Reservations", icon: ReservationIcon },
] as const;

export function SidebarNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="fixed left-4 top-3 z-40 inline-flex items-center gap-2 rounded-full border border-white/10 bg-navy px-3 py-2 text-sm font-medium text-white shadow-lg lg:hidden"
        aria-expanded={open}
        aria-controls="app-sidebar"
        onClick={() => setOpen((current) => !current)}
      >
        <MenuIcon />
        {open ? "Close" : "Menu"}
      </button>

      {open ? (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-navy/40 lg:hidden"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      ) : null}

      <aside
        id="app-sidebar"
        className={`fixed inset-y-0 left-0 z-30 flex w-72 flex-col bg-navy text-slate-200 transition-transform lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="border-b border-white/10 px-6 py-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-200">
            MediaIQ
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            Marketing intelligence shell
          </p>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Primary">
          <ul className="space-y-1">
            {destinations.map((item) => {
              const active = destinationActive(item.href, pathname);

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setOpen(false)}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                      active
                        ? "bg-navy-raised text-white"
                        : "text-slate-300 hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    <item.icon />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>
    </>
  );
}

function destinationActive(href: string, pathname: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  if (href === "/performance") {
    return pathname === "/performance" || pathname.startsWith("/evidence/");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

function IconFrame({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-5 w-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function MenuIcon() {
  return (
    <IconFrame>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </IconFrame>
  );
}

function GridIcon() {
  return (
    <IconFrame>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </IconFrame>
  );
}

function UploadIcon() {
  return (
    <IconFrame>
      <path d="M12 16V6" />
      <path d="m8 9 4-4 4 4" />
      <path d="M5 19h14" />
    </IconFrame>
  );
}

function ChartIcon() {
  return (
    <IconFrame>
      <path d="M4 19h16" />
      <path d="M7 16V9" />
      <path d="M12 16V5" />
      <path d="M17 16v-4" />
    </IconFrame>
  );
}

function CoinIcon() {
  return (
    <IconFrame>
      <ellipse cx="12" cy="7" rx="7" ry="3" />
      <path d="M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7" />
      <path d="M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" />
    </IconFrame>
  );
}

function PeopleIcon() {
  return (
    <IconFrame>
      <circle cx="9" cy="9" r="3" />
      <path d="M4.5 18c.6-2.4 2.4-3.5 4.5-3.5s3.9 1.1 4.5 3.5" />
      <circle cx="16.5" cy="9.5" r="2.2" />
      <path d="M16 14.6c1.6.2 2.8 1.1 3.4 3.4" />
    </IconFrame>
  );
}

function LayersIcon() {
  return (
    <IconFrame>
      <path d="M12 4 4 8l8 4 8-4-8-4Z" />
      <path d="m4 12 8 4 8-4" />
      <path d="m4 16 8 4 8-4" />
    </IconFrame>
  );
}

function SparkIcon() {
  return (
    <IconFrame>
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="m5.6 5.6 2.8 2.8" />
      <path d="m15.6 15.6 2.8 2.8" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
      <path d="m5.6 18.4 2.8-2.8" />
      <path d="m15.6 8.4 2.8-2.8" />
    </IconFrame>
  );
}

function CompassIcon() {
  return (
    <IconFrame>
      <circle cx="12" cy="12" r="8" />
      <path d="m14.8 9.2-1.2 4.4-4.4 1.2 1.2-4.4 4.4-1.2Z" />
    </IconFrame>
  );
}

function DocumentIcon() {
  return (
    <IconFrame>
      <path d="M7 3.5h7l4 4V20.5H7v-17Z" />
      <path d="M14 3.5v4h4" />
      <path d="M9.5 12.5h5" />
      <path d="M9.5 16h5" />
    </IconFrame>
  );
}

function ReservationIcon() {
  return (
    <IconFrame>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v8M9.5 10.5c.4-.8 1.2-1.2 2.5-1.2 1.5 0 2.5.7 2.5 1.8s-1 1.7-2.5 1.9-2.5.8-2.5 1.9 1 1.8 2.5 1.8c1.3 0 2.1-.4 2.5-1.2" />
    </IconFrame>
  );
}

function GearIcon() {
  return (
    <IconFrame>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M4.8 6.6l1.6 1.6M17.6 15.8l1.6 1.6M3.5 12h2.2M18.3 12h2.2M4.8 17.4l1.6-1.6M17.6 8.2l1.6-1.6" />
    </IconFrame>
  );
}
