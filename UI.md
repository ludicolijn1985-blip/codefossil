# UI specification

> **Implementation status.** `apps/web` implements Overview (with historical hotspots),
> Investigations (as "Investigate"), file detail with its timeline, Graph, Hotspots, Dead Intent
> and Dependencies. Architecture, Issues & PRs and Settings are not built yet and are left out of
> the navigation rather than shown as placeholders.

Design language:

- dark-first developer interface
- near-black background
- subtle grid/noise
- restrained neon accent
- glass panels used sparingly
- monospace metadata
- dense but readable information
- keyboard-first navigation
- no decorative AI gimmicks

Navigation:
Overview
Timeline
Architecture
Graph
Investigations
Hotspots
Dead Intent
Dependencies
Issues & PRs
Settings

## Overview

Top:
Repository name / branch / last indexed / index health.

Metrics:
commits, files, symbols, dependencies, issues, PRs.

Main:

- architecture map
- recent changes
- historical hotspots
- investigation suggestions

## Investigation view

Left:
question/history

Center:
answer + confidence + evidence chain

Right:
evidence inspector

Bottom:
timeline slider

## File detail

Header:
path, language, ownership, last change

Tabs:
Current
History
Why
Impact
Dependencies
Tests

History:
commit timeline with diff summaries.

Why:
evidence chain and inferred intent.

Impact:
graph with traversal paths.

## Graph

React Flow.
Node types:
file, symbol, commit, issue, PR, test, dependency, incident.

Edges are typed and visually distinct.
Clicking any edge opens provenance.

## Accessibility

- WCAG 2.2 AA target
- keyboard navigation
- visible focus
- reduced-motion support
- screen-reader labels
- contrast checks
