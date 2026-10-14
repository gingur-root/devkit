// The provider map (devkit#107): the pipeline's parts as nodes with their
// logos, and the links between them, drawn with AI Elements Workflow.
import { type Edge, MarkerType, type Node as FlowNode, type NodeProps } from '@xyflow/react';

import { LINKS, type Part, PARTS } from './architecture.ts';
import { Canvas } from './components/ai-elements/canvas.tsx';
import { Controls } from './components/ai-elements/controls.tsx';
import {
  Node,
  NodeContent,
  NodeDescription,
  NodeHeader,
  NodeTitle,
} from './components/ai-elements/node.tsx';

const COLUMN = 340;
const ROW = 170;

type PartNode = FlowNode<Part, 'part'>;

function Logo({ logo: Icon }: { logo: Part['logo'] }) {
  // A white tile keeps dark brand marks (GitHub) visible in dark mode.
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-white p-1.5 text-neutral-900 ring-1 ring-border">
      {'path' in Icon ? (
        <svg viewBox="0 0 24 24" role="img" aria-label={Icon.title} className="size-full">
          <path d={Icon.path} fill={`#${Icon.hex}`} />
        </svg>
      ) : (
        <Icon className="size-full" aria-hidden />
      )}
    </span>
  );
}

function PartView({ data }: NodeProps<PartNode>) {
  return (
    <Node handles={{ target: true, source: true }} className="w-60">
      <NodeHeader className="flex flex-row items-center gap-2">
        <Logo logo={data.logo} />
        <div className="min-w-0">
          <NodeDescription className="text-xs">{data.provider}</NodeDescription>
          <NodeTitle className="text-sm">{data.title}</NodeTitle>
        </div>
      </NodeHeader>
      <NodeContent className="text-xs text-muted-foreground">{data.detail}</NodeContent>
    </Node>
  );
}

const nodeTypes = { part: PartView };

const nodes: PartNode[] = Object.entries(PARTS).map(([id, part]) => ({
  id,
  type: 'part',
  position: { x: part.at[0] * COLUMN, y: part.at[1] * ROW },
  data: part,
}));

const edges: Edge[] = LINKS.map(({ from, to, label }) => ({
  id: `${from}-${to}`,
  source: from,
  target: to,
  label,
  markerEnd: { type: MarkerType.ArrowClosed },
}));

export default function MapView() {
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-4 border-b px-4 py-3">
        <a href="#" className="text-muted-foreground">
          Board
        </a>
        <h1 className="font-semibold">Map</h1>
      </header>
      <div className="min-h-0 flex-1">
        {/* A picture, not an editor: pan and zoom only. */}
        <Canvas
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode="system"
          minZoom={0.1}
          panOnDrag
          selectionOnDrag={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
        >
          <Controls showInteractive={false} />
        </Canvas>
      </div>
    </div>
  );
}
