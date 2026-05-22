/**
 * useLocalStorage hook
 */

import { useState, useEffect, useCallback } from "react";
import { useProductSDK } from "./context.js";

/**
 * Hook for key-value storage operations
 *
 * @param key - Storage key
 * @param defaultValue - Default value if key doesn't exist
 *
 * @example
 * ```tsx
 * function ThemeToggle() {
 *   const [theme, setTheme, { loading }] = useLocalStorage('theme', 'light');
 *
 *   if (loading) return <div>Loading...</div>;
 *
 *   return (
 *     <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
 *       Current: {theme}
 *     </button>
 *   );
 * }
 * ```
 */
export function useLocalStorage<T = string>(
    key: string,
    defaultValue?: T,
): [T | null, (value: T) => Promise<void>, { loading: boolean; error: Error | null }] {
    const app = useProductSDK();

    const [value, setValue] = useState<T | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    // Load initial value
    useEffect(() => {
        let mounted = true;

        const loadValue = async () => {
            try {
                setLoading(true);
                const stored = await app.localStorage.getJSON<T>(key);
                if (mounted) {
                    setValue(stored ?? defaultValue ?? null);
                    setLoading(false);
                }
            } catch (e) {
                if (mounted) {
                    setError(e instanceof Error ? e : new Error(String(e)));
                    setLoading(false);
                }
            }
        };

        loadValue();

        return () => {
            mounted = false;
        };
    }, [app, key, defaultValue]);

    const setStoredValue = useCallback(
        async (newValue: T) => {
            try {
                setError(null);
                await app.localStorage.setJSON(key, newValue);
                setValue(newValue);
            } catch (e) {
                setError(e instanceof Error ? e : new Error(String(e)));
                throw e;
            }
        },
        [app, key],
    );

    return [value, setStoredValue, { loading, error }];
}

/**
 * Hook for string storage (simpler API)
 *
 * @param key - Storage key
 * @param defaultValue - Default value
 */
export function useLocalStorageString(
    key: string,
    defaultValue?: string,
): [string | null, (value: string) => Promise<void>, { loading: boolean }] {
    const app = useProductSDK();

    const [value, setValue] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let mounted = true;

        const loadValue = async () => {
            const stored = await app.localStorage.get(key);
            if (mounted) {
                setValue(stored ?? defaultValue ?? null);
                setLoading(false);
            }
        };

        loadValue();

        return () => {
            mounted = false;
        };
    }, [app, key, defaultValue]);

    const setStoredValue = useCallback(
        async (newValue: string) => {
            await app.localStorage.set(key, newValue);
            setValue(newValue);
        },
        [app, key],
    );

    return [value, setStoredValue, { loading }];
}
