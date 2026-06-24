import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Tests must be independent (no shared DOM state between cases) — unmount every
// rendered tree after each test so queries never match a previous test's nodes.
afterEach(() => cleanup());
