import type React from 'react';
import type { CardPayload } from '../api/client';
import type { AgyPlugin, CapsuleSlotProps, CardRendererProps } from './types';

class FrontendPluginRegistry {
  private plugins = new Map<string, AgyPlugin>();
  private cardMap = new Map<string, React.ComponentType<CardRendererProps<any>>>();

  register(plugin: AgyPlugin) {
    this.plugins.set(plugin.id, plugin);
    if (plugin.cards) {
      for (const [cardType, Comp] of Object.entries(plugin.cards)) {
        this.cardMap.set(cardType, Comp);
      }
    }
  }

  getCapsuleComponent(): React.ComponentType<CapsuleSlotProps> | null {
    for (const plugin of this.plugins.values()) {
      if (plugin.slots?.['bottom-capsule']) {
        return plugin.slots['bottom-capsule'];
      }
    }
    return null;
  }

  getCardComponent(cardType: string): React.ComponentType<CardRendererProps<any>> | null {
    return this.cardMap.get(cardType) ?? null;
  }

  listPlugins(): AgyPlugin[] {
    return Array.from(this.plugins.values());
  }
}

export const frontendPluginRegistry = new FrontendPluginRegistry();

export function renderPluginCard(
  payload: CardPayload,
  onAction: (pluginId: string, actionId: string, data?: Record<string, unknown>) => void
) {
  const Comp = frontendPluginRegistry.getCardComponent(payload.cardType);
  if (!Comp) return null;
  return <Comp key={payload.id} payload={payload} onAction={onAction} />;
}
