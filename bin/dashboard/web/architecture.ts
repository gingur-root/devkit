// The pipeline's parts and links, for the map view (devkit#107). infra's
// docs/architecture.excalidraw.svg stays the source of truth; this mirrors it.
import { type LucideIcon, Bot, Smartphone } from 'lucide-react';
import {
  type SimpleIcon,
  siBitwarden,
  siClaude,
  siCloudflare,
  siGithub,
  siGithubactions,
  siIonos,
  siUbuntu,
} from 'simple-icons';

// A type, not an interface: React Flow node data must be a Record.
export type Part = {
  provider: string;
  title: string;
  detail: string;
  /** simple-icons has no OpenAI logo, so Codex and Troy take a Lucide icon. */
  logo: SimpleIcon | LucideIcon;
  /** Column and row on the map's grid, left to right as the work flows. Rows are
   * fractional so a long link's midpoint label lands between nodes, not under one. */
  at: readonly [column: number, row: number];
};

export const PARTS = {
  troy: {
    provider: 'Troy',
    title: 'Phone or desk',
    detail: 'the only actor who can start a stage',
    logo: Smartphone,
    at: [0, 2],
  },
  claude: {
    provider: 'Claude',
    title: 'Claude Project',
    detail: 'coordinator chat, a thread per ask; Max plan',
    logo: siClaude,
    at: [1, 0],
  },
  codex: {
    provider: 'Codex',
    title: 'ChatGPT plan',
    detail: 'one device login per runner user',
    logo: Bot,
    at: [1, 1],
  },
  tunnel: {
    provider: 'Cloudflare',
    title: 'Tunnel + Access',
    detail: 'dashboard.gingur.com · vps.gingur.com · vps-ci',
    logo: siCloudflare,
    at: [1, 2.4],
  },
  bitwarden: {
    provider: 'Bitwarden',
    title: 'Secrets Manager',
    detail: 'infra-roots · pipeline · agents · dashboard',
    logo: siBitwarden,
    at: [1, 3.4],
  },
  desk: {
    provider: 'WSL desk',
    title: 'Claude Code · Codex',
    detail: 'thread Claudes write code and PRs',
    logo: siUbuntu,
    at: [2, 0],
  },
  dashboard: {
    provider: 'VPS',
    title: 'Dashboard',
    detail: 'coordinator on the Claude Agent SDK',
    logo: siIonos,
    at: [2, 3.2],
  },
  issues: {
    provider: 'GitHub',
    title: 'Issues + board',
    detail: 'labels start a stage; Ask → Done',
    logo: siGithub,
    at: [3, 1.5],
  },
  app: {
    provider: 'GitHub',
    title: 'Pipeline App',
    detail: 'writes comments, PRs, cards; never infra',
    logo: siGithub,
    at: [3, 3.3],
  },
  actions: {
    provider: 'GitHub',
    title: 'Actions workflows',
    detail: 'plan → build → review ⇄ repair; infra workflows',
    logo: siGithubactions,
    at: [4, 1.5],
  },
  elevated: {
    provider: 'WSL desk',
    title: 'Elevated runner',
    detail: 'runner group wsl, kept up by the gingur stack',
    logo: siUbuntu,
    at: [5, 0],
  },
  runners: {
    provider: 'VPS',
    title: 'Agent runners',
    detail: 'runner1 … runnerN, runner group local',
    logo: siIonos,
    at: [5, 1],
  },
  infra: {
    provider: 'VPS',
    title: 'infra runner',
    detail: 'runs pulumi preview / up',
    logo: siIonos,
    at: [5, 2.6],
  },
  r2: {
    provider: 'Cloudflare',
    title: 'R2 buckets',
    detail: 'pulumi-state · runs · backups',
    logo: siCloudflare,
    at: [6, 1.8],
  },
} as const satisfies Record<string, Part>;

export type PartId = keyof typeof PARTS;

export interface Link {
  from: PartId;
  to: PartId;
  label: string;
}

export const LINKS: readonly Link[] = [
  { from: 'troy', to: 'claude', label: 'asks in chat' },
  { from: 'troy', to: 'issues', label: 'labels' },
  { from: 'troy', to: 'tunnel', label: 'browser' },
  { from: 'claude', to: 'desk', label: 'threads' },
  { from: 'claude', to: 'dashboard', label: 'subscription token' },
  { from: 'claude', to: 'runners', label: 'setup-token' },
  { from: 'codex', to: 'desk', label: 'Codex CLI' },
  { from: 'codex', to: 'runners', label: 'device login' },
  { from: 'tunnel', to: 'dashboard', label: 'tunnel' },
  { from: 'bitwarden', to: 'dashboard', label: 'bws run' },
  { from: 'bitwarden', to: 'runners', label: 'bws run' },
  { from: 'desk', to: 'issues', label: 'PRs' },
  { from: 'dashboard', to: 'app', label: 'acts as' },
  { from: 'issues', to: 'actions', label: 'label starts a stage' },
  { from: 'app', to: 'actions', label: 'App token' },
  { from: 'actions', to: 'elevated', label: 'agent:elevated' },
  { from: 'actions', to: 'runners', label: 'agent jobs' },
  { from: 'actions', to: 'infra', label: 'runs on' },
  { from: 'runners', to: 'r2', label: 'transcripts' },
  { from: 'infra', to: 'r2', label: 'state' },
];
