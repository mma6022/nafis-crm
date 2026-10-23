import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetAuthSessionQueryKey } from '@workspace/api-client-react';

export const TABLE_STATE_KEY = 'table-view-state';

/** Navigation-only state: never store forms, records or credentials here. */
export function useTableState<T>(field: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const client = useQueryClient();
  const session = client.getQueryData<{ user?: { id: number; role?: string; customerScope?: string } }>(getGetAuthSessionQueryKey());
  // Keep deep-linked lists separate; returning through browser history restores
  // the chosen filters rather than reapplying the original URL defaults.
  const key = useRef([TABLE_STATE_KEY, session?.user?.id ?? 'anonymous',
    session?.user?.role, session?.user?.customerScope,
    window.location.pathname, window.location.search, field]).current;
  const [value, setValue] = useState<T>(() => {
    const saved = client.getQueryData<{ value: T }>(key);
    return saved ? saved.value : typeof initial === 'function' ? (initial as () => T)() : initial;
  });
  const current = useRef(value);
  const update = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    const next = typeof action === 'function' ? (action as (previous: T) => T)(current.current) : action;
    current.current = next;
    // Save synchronously: even immediate navigation in the same event is safe.
    client.setQueryData(key, { value: next });
    setValue(next);
  }, [client, key]);
  return [value, update];
}
