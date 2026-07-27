'use client';

import { useState, type ReactNode } from 'react';

export interface ScreenerTab {
  id: string;
  label: string;
  /**
   * Rows the panel renders (listed or not), so the badge always matches the
   * table beneath it and the default tab never lands on an empty lane while
   * a populated one sits unseen.
   */
  count: number;
  content: ReactNode;
}

/**
 * Client shell around server-rendered tables: both lanes arrive fully rendered
 * as props, so switching tabs reveals markup that already exists — no client
 * fetch, and the inactive lane stays in the DOM (hidden) for crawlers.
 */
export default function ScreenerTabs({ tabs }: { tabs: ScreenerTab[] }) {
  const first = tabs.find((t) => t.count > 0) ?? tabs[0];
  const [active, setActive] = useState(first?.id ?? '');

  return (
    <div className="tabs">
      <div className="tabs__bar" role="tablist" aria-label="Listing lanes">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={active === tab.id}
            aria-controls={`panel-${tab.id}`}
            className={`tabs__btn${active === tab.id ? ' tabs__btn--active' : ''}`}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
            <span className="tabs__count num">{tab.count}</span>
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`panel-${tab.id}`}
          aria-labelledby={`tab-${tab.id}`}
          hidden={active !== tab.id}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
