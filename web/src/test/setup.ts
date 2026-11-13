import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Tell React this is a test environment, so updates outside `act` are reported. Testing Library
// only sets this itself when test globals are on, and this suite imports from `vitest` instead.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Code that reads the target (resolveBrowserEnv) sees the test target, never prod.
vi.stubEnv('VITE_STDB_TARGET', 'test');

// jsdom does not implement scrolling; the router's scroll restoration calls it.
window.scrollTo = () => {};

// Unmount what each test rendered (no globals, so Testing Library cannot register this itself).
afterEach(() => {
    cleanup();
});
