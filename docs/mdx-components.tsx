// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { useMDXComponents as getDocsMDXComponents } from "nextra-theme-docs";

const docsComponents = getDocsMDXComponents();

export function useMDXComponents(components?: Record<string, React.ComponentType>) {
  return {
    ...docsComponents,
    ...components,
  };
}
