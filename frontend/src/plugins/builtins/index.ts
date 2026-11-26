import { frontendPluginRegistry } from '../registry';
import { ApprovalCard } from './ApprovalCard';
import { CapsuleBar } from './CapsuleBar';
import { DiffPreviewCard } from './DiffPreviewCard';
import { AuthGuideCard, SystemMiniCard } from './SystemMiniCard';
import { ToolCallCard } from './ToolCallCard';

let registered = false;

export function registerBuiltinPlugins() {
  if (registered) return;
  registered = true;

  frontendPluginRegistry.register({
    id: 'core.capsule',
    name: 'Obsidian 状态胶囊',
    version: '1.0.0',
    description: '底部常驻胶囊状态栏，预留 agy-capsule 同步扩展接口',
    slots: {
      'bottom-capsule': CapsuleBar,
    },
  });

  frontendPluginRegistry.register({
    id: 'core.cards',
    name: '核心交互卡片包',
    version: '1.0.0',
    description: '工具调用、文件摘要、审批确认、电脑速览与登录引导卡',
    cards: {
      'core.tool-call': ToolCallCard,
      'core.diff-preview': DiffPreviewCard,
      'core.approval': ApprovalCard,
      'core.system-mini': SystemMiniCard,
      'core.auth-guide': AuthGuideCard,
    },
  });
}
