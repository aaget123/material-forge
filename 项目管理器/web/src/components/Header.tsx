import { LayoutGrid, List, Plus, Search } from 'lucide-react';
import Icon from './Icon.tsx';

export type ViewMode = 'grid' | 'list';

interface Props {
  title: string;
  /** 标题的悬停提示（项目简介放这里，不占主区版面） */
  titleHint?: string;
  query: string;
  onQueryChange: (query: string) => void;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  onAddContent: () => void;
  addDisabled?: boolean;
  /** 回收站视图里不显示「添加素材」：那儿的动作只有恢复和清空 */
  hideAdd?: boolean;
  /** 标题右侧的额外操作（例如回收站里的「清空回收站」） */
  rightExtra?: React.ReactNode;
  /** 左右面板的开合状态：面板关掉之后，开关就落在这条工具栏上 */
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export default function Header({
  title, titleHint, query, onQueryChange, view, onViewChange, onAddContent, addDisabled, hideAdd = false, rightExtra,
  sidebarOpen, onToggleSidebar,
}: Props): React.ReactElement {
  return (
    <header className="page-header">
      <div className="page-header-row">
        <div className="page-header-left">
        </div>
      </div>
    </header>
  );
}
