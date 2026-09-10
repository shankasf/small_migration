import { Blocks, Cloud, Github, GitBranch, LucideIcon } from 'lucide-react';
import { IntegrationProvider } from './types';

export interface IntegrationProviderInfo {
  id: IntegrationProvider;
  name: string;
  description: string;
  category: string;
  permission: string;
  icon: LucideIcon;
  accent: string;
  surface: string;
}

export const INTEGRATION_PROVIDERS: IntegrationProviderInfo[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Connect your GitHub account and choose repositories and branches for your workspace.',
    category: 'Source control',
    permission: 'GitHub App · Read-only repositories',
    icon: Github,
    accent: 'text-ink',
    surface: 'bg-ink/[0.08]',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'Bring GitLab-hosted models and merge request context into migrations.',
    category: 'Source control',
    permission: 'OAuth · Read repository',
    icon: GitBranch,
    accent: 'text-warn',
    surface: 'bg-warn/10',
  },
  {
    id: 'snowflake',
    name: 'Snowflake',
    description: 'Validate schemas, inspect metadata, and test generated transformations.',
    category: 'Data warehouse',
    permission: 'Key-pair authentication',
    icon: Cloud,
    accent: 'text-signal',
    surface: 'bg-signal/10',
  },
  {
    id: 'dbt',
    name: 'dbt',
    description: 'Connect dbt Cloud metadata, projects, jobs, and lineage context.',
    category: 'Transformation',
    permission: 'Scoped service token',
    icon: Blocks,
    accent: 'text-brass-bright',
    surface: 'bg-brass/10',
  },
];
