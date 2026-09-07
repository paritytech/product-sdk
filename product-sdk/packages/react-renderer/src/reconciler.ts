// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { createContext } from "react";
import ReactReconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants.js";

import type { RenderCallback } from "./context.js";
import { noop } from "./helpers.js";
import type { TextInstance, WidgetInstance } from "./serializer.js";
import { serializeAndRender } from "./serializer.js";

export type Container = {
    onRender: RenderCallback;
    children: (WidgetInstance | TextInstance)[];
};

const RESERVED_PROPS = new Set(["children", "key", "ref"]);

function filterProps(props: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
        if (!RESERVED_PROPS.has(key)) result[key] = props[key];
    }
    return result;
}

function removeChild(
    arr: (WidgetInstance | TextInstance)[],
    child: WidgetInstance | TextInstance,
): void {
    const idx = arr.indexOf(child);
    if (idx !== -1) arr.splice(idx, 1);
}

function insertBefore(
    arr: (WidgetInstance | TextInstance)[],
    child: WidgetInstance | TextInstance,
    beforeChild: WidgetInstance | TextInstance,
): void {
    removeChild(arr, child);
    const idx = arr.indexOf(beforeChild);
    arr.splice(idx !== -1 ? idx : arr.length, 0, child);
}

let currentUpdatePriority: number = DefaultEventPriority;

// HostTransitionContext is typed as the internal ReactContext<T> (with _currentValue, etc.)
// rather than the public React.Context<T>. React.createContext() produces the same internal
// structure at runtime; the type mismatch is between the two TypeScript declarations only.
const transitionContext = createContext<null>(
    null,
) as unknown as ReactReconciler.ReactContext<null>;

const hostConfig: ReactReconciler.HostConfig<
    string, // Type
    Record<string, unknown>, // Props
    Container, // Container
    WidgetInstance, // Instance
    TextInstance, // TextInstance
    never, // SuspenseInstance
    never, // HydratableInstance
    never, // FormInstance
    WidgetInstance, // PublicInstance
    Record<string, never>, // HostContext
    never, // ChildSet
    ReturnType<typeof setTimeout>, // TimeoutHandle
    -1, // NoTimeout
    null // TransitionStatus
> = {
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    isPrimaryRenderer: false,
    warnsIfNotActing: false,

    // Scheduler
    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,
    noTimeout: -1,
    supportsMicrotasks: true,
    scheduleMicrotask: queueMicrotask,

    // Update priority (trivially tracked; unused with synchronous LegacyRoot rendering)
    setCurrentUpdatePriority(priority) {
        currentUpdatePriority = priority;
    },
    getCurrentUpdatePriority() {
        return currentUpdatePriority;
    },
    resolveUpdatePriority() {
        return currentUpdatePriority;
    },

    // Transitions (not used — LegacyRoot mode has no concurrent transitions)
    NotPendingTransition: null,
    HostTransitionContext: transitionContext,

    // Host context (not used — same context throughout the tree)
    getRootHostContext: () => ({}),
    getChildHostContext: (ctx) => ctx,
    getPublicInstance: (instance) => instance as WidgetInstance,

    // Instance creation
    createInstance(type, props) {
        return { type, props: filterProps(props), children: [] };
    },
    createTextInstance(text) {
        return { __isText: true, text };
    },

    appendInitialChild(parent, child) {
        parent.children.push(child);
    },
    finalizeInitialChildren: () => false,
    shouldSetTextContent: () => false,

    // Commit
    prepareForCommit: () => null,
    resetAfterCommit(container) {
        container.onRender(serializeAndRender(container.children));
    },

    // Mutation
    commitUpdate(instance, _type, prevProps, nextProps) {
        const oldFiltered = filterProps(prevProps);
        const newFiltered = filterProps(nextProps);
        const keys = new Set([...Object.keys(oldFiltered), ...Object.keys(newFiltered)]);
        for (const key of keys) {
            if (oldFiltered[key] !== newFiltered[key]) {
                instance.props = newFiltered;
                return;
            }
        }
    },
    commitTextUpdate(instance, _oldText, newText) {
        instance.text = newText;
    },

    // Children
    appendChild(parent, child) {
        parent.children.push(child);
    },
    appendChildToContainer(container, child) {
        container.children.push(child);
    },
    removeChild(parent, child) {
        removeChild(parent.children, child);
    },
    removeChildFromContainer(container, child) {
        removeChild(container.children, child);
    },
    insertBefore(parent, child, before) {
        insertBefore(parent.children, child, before);
    },
    insertInContainerBefore(container, child, before) {
        insertBefore(container.children, child, before);
    },
    clearContainer(container) {
        container.children = [];
    },

    // Portal / cleanup
    preparePortalMount: noop,
    detachDeletedInstance: noop,

    // Scope (not used)
    getInstanceFromNode: () => null,
    beforeActiveInstanceBlur: noop,
    afterActiveInstanceBlur: noop,
    prepareScopeUpdate: noop,
    getInstanceFromScope: () => null,

    // Forms (not used)
    resetFormInstance: noop,

    // Post-paint callbacks (not used)
    requestPostPaintCallback: noop,

    // Eager transitions (not used)
    shouldAttemptEagerTransition: () => false,

    // Scheduler event tracking (not used)
    trackSchedulerEvent: noop,
    resolveEventType: () => null,
    resolveEventTimeStamp: () => -1,

    // Suspense commit (not used)
    maySuspendCommit: () => false,
    preloadInstance: () => true,
    startSuspendingCommit: noop,
    suspendInstance: noop,
    waitForCommitToBeReady: () => null,
};

export const reconciler = ReactReconciler(hostConfig);

reconciler.injectIntoDevTools({
    bundleType: 0,
    version: "0.0.0",
    rendererPackageName: "@parity/product-sdk-react-renderer",
});
