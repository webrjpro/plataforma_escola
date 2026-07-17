/**
 * BlockEditor.tsx — Editor visual de blocos com Drag & Drop
 *
 * O admin monta o conteúdo da aula arrastando blocos:
 * - Texto (rich text via ReactQuill)
 * - Imagem (upload + posição)
 * - Duas Colunas (cada uma com conteúdo)
 * - Destaque, Exemplo, Fórmula, etc.
 *
 * O layout é salvo como JSON no campo `content` do vídeo.
 * A LessonPage renderiza esse JSON em folha branca.
 */
import { useState, useRef, useMemo, useCallback } from 'react';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
    GripVertical, Trash2, Type, ImageIcon, Columns2,
    Lightbulb, AlertTriangle, BookOpen, Calculator,
    Plus, ChevronDown, ChevronUp, Eye, Pencil, Code2
} from 'lucide-react';
import ReactQuill, { Quill } from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import api from '../lib/api';
import DOMPurify from 'dompurify';
import { resolveMediaUrl } from '../lib/urls';

// ─── Register custom fonts with Quill ───
const Font = Quill.import('formats/font') as { whitelist: string[] };
const FONT_LIST = [
    'arial', 'georgia', 'impact', 'tahoma', 'verdana',
    'courier-new', 'times-new-roman', 'trebuchet-ms', 'comic-sans-ms',
    'roboto', 'open-sans', 'lato', 'montserrat', 'poppins',
    'raleway', 'nunito', 'inter', 'playfair-display', 'merriweather',
    'source-sans-pro', 'pt-sans', 'ubuntu', 'oswald', 'rubik',
];
Font.whitelist = FONT_LIST;
Quill.register('formats/font', Font, true);

// ─── Block Types ───
export type BlockType = 'text' | 'image' | 'two-columns' | 'highlight' | 'example' | 'solution' | 'tip' | 'warning' | 'formula' | 'heading' | 'html-css';

export interface ContentBlock {
    id: string;
    type: BlockType;
    data: Record<string, string>;
}

interface BlockEditorProps {
    blocks: ContentBlock[];
    onChange: (blocks: ContentBlock[]) => void;
}

// ─── Helper: generate unique id ───
function uid(): string {
    return `blk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Font label map for display ───
const FONT_LABELS: Record<string, string> = {
    'arial': 'Arial', 'georgia': 'Georgia', 'impact': 'Impact',
    'tahoma': 'Tahoma', 'verdana': 'Verdana', 'courier-new': 'Courier New',
    'times-new-roman': 'Times New Roman', 'trebuchet-ms': 'Trebuchet MS',
    'comic-sans-ms': 'Comic Sans MS', 'roboto': 'Roboto', 'open-sans': 'Open Sans',
    'lato': 'Lato', 'montserrat': 'Montserrat', 'poppins': 'Poppins',
    'raleway': 'Raleway', 'nunito': 'Nunito', 'inter': 'Inter',
    'playfair-display': 'Playfair Display', 'merriweather': 'Merriweather',
    'source-sans-pro': 'Source Sans Pro', 'pt-sans': 'PT Sans', 'ubuntu': 'Ubuntu',
    'oswald': 'Oswald', 'rubik': 'Rubik',
};
void FONT_LABELS; // used by CSS generation

// ─── Quill config ───
const QUILL_MODULES = {
    toolbar: [
        [{ font: FONT_LIST }],
        [{ header: [1, 2, 3, false] }],
        ['bold', 'italic', 'underline', 'strike'],
        [{ color: [] }, { background: [] }],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['blockquote'],
        [{ align: [] }],
        ['link'],
        ['clean'],
    ],
};

const QUILL_FORMATS = [
    'font', 'header', 'bold', 'italic', 'underline', 'strike',
    'color', 'background', 'list', 'blockquote', 'align', 'link',
];

// ─── Background color presets ───
const BG_PRESETS = [
    '', '#ffffff', '#f8fafc', '#f1f5f9', '#fefce8', '#fef3c7',
    '#ecfdf5', '#ecfeff', '#eff6ff', '#fdf2f8', '#fef2f2',
    '#f5f3ff', '#fafaf9', '#fff7ed', '#f0fdf4', '#e0f2fe',
];

// ─── Block palette items ───
const BLOCK_PALETTE: { type: BlockType; icon: typeof Type; label: string; color: string }[] = [
    { type: 'heading', icon: Type, label: 'Título', color: '#1f2937' },
    { type: 'text', icon: Type, label: 'Texto', color: '#6366f1' },
    { type: 'image', icon: ImageIcon, label: 'Imagem', color: '#06b6d4' },
    { type: 'two-columns', icon: Columns2, label: '2 Colunas', color: '#8b5cf6' },
    { type: 'highlight', icon: AlertTriangle, label: 'Destaque', color: '#f59e0b' },
    { type: 'example', icon: BookOpen, label: 'Exemplo', color: '#3b82f6' },
    { type: 'solution', icon: Calculator, label: 'Resolução', color: '#10b981' },
    { type: 'tip', icon: Lightbulb, label: 'Dica', color: '#06b6d4' },
    { type: 'warning', icon: AlertTriangle, label: 'Aviso', color: '#ef4444' },
    { type: 'formula', icon: Calculator, label: 'Fórmula', color: '#7c3aed' },
    { type: 'html-css', icon: Code2, label: 'HTML + CSS', color: '#0ea5e9' },
];

function createDefaultData(type: BlockType): Record<string, string> {
    switch (type) {
        case 'heading': return { text: 'Título da Seção' };
        case 'text': return { html: '<p>Digite o texto aqui...</p>' };
        case 'image': return { url: '', caption: '', align: 'center' };
        case 'two-columns': return { left: '<p>Coluna esquerda...</p>', right: '<p>Coluna direita...</p>' };
        case 'highlight': return { title: 'Destaque', html: '<p>Conteúdo em destaque...</p>' };
        case 'example': return { title: 'Exemplo', html: '<p>Conteúdo do exemplo...</p>' };
        case 'solution': return { title: 'Resolução', html: '<p>Passos da resolução...</p>' };
        case 'tip': return { title: 'Dica', html: '<p>Texto da dica...</p>' };
        case 'warning': return { title: 'Atenção', html: '<p>Texto do aviso...</p>' };
        case 'formula': return { text: 'f(x) = ax² + bx + c' };
        case 'html-css':
            return {
                html: '<div class="card">\n  <h3>Bloco livre</h3>\n  <p>Você pode montar seu próprio layout aqui.</p>\n</div>',
                css: '.card { border: 1px solid #cbd5e1; border-radius: 10px; padding: 1rem; background: #f8fafc; }\n.card h3 { margin: 0 0 0.5rem 0; }'
            };
        default: return {};
    }
}

// ─── Sortable Block Wrapper ───
function SortableBlock({ block, children, onDelete, onUpdate }: {
    block: ContentBlock;
    children: React.ReactNode;
    onDelete: () => void;
    onUpdate: (data: Record<string, string>) => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id });
    const [showBgPicker, setShowBgPicker] = useState(false);
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
    };

    const typeLabel = BLOCK_PALETTE.find(b => b.type === block.type)?.label || block.type;
    const bgColor = block.data.bgColor || '';

    return (
        <div ref={setNodeRef} style={{ ...style, background: bgColor || undefined }} className={`be-block-wrapper${isDragging ? ' is-dragging' : ''}`}>
            <div className="be-block-handle" {...attributes} {...listeners}>
                <GripVertical size={16} />
            </div>
            <div className="be-block-body">
                {children}
            </div>
            <div className="be-block-actions">
                <span className="be-type-badge">{typeLabel}</span>
                <div className="be-bg-picker-wrap">
                    <button
                        className="be-bg-btn"
                        onClick={() => setShowBgPicker(!showBgPicker)}
                        title="Cor de fundo"
                        style={bgColor ? { background: bgColor, borderColor: bgColor } : undefined}
                    >
                        🎨
                    </button>
                    {showBgPicker && (
                        <div className="be-bg-picker">
                            {BG_PRESETS.map((c, i) => (
                                <button
                                    key={i}
                                    className={`be-bg-swatch${bgColor === c ? ' active' : ''}`}
                                    style={{ background: c || 'transparent' }}
                                    onClick={() => { onUpdate({ ...block.data, bgColor: c }); setShowBgPicker(false); }}
                                    title={c || 'Sem fundo'}
                                >
                                    {!c && '✕'}
                                </button>
                            ))}
                            <input
                                type="color"
                                value={bgColor || '#ffffff'}
                                onChange={e => onUpdate({ ...block.data, bgColor: e.target.value })}
                                className="be-bg-custom"
                                title="Cor personalizada"
                            />
                        </div>
                    )}
                </div>
                <button onClick={onDelete} className="be-delete-btn" title="Remover bloco">
                    <Trash2 size={14} />
                </button>
            </div>
        </div>
    );
}

// ─── Individual Block Editors ───
function HeadingEditor({ data, onChange }: { data: Record<string, string>; onChange: (d: Record<string, string>) => void }) {
    return (
        <input
            className="be-heading-input"
            value={data.text || ''}
            onChange={e => onChange({ ...data, text: e.target.value })}
            placeholder="Digite o título..."
        />
    );
}

function TextEditor({ data, onChange }: { data: Record<string, string>; onChange: (d: Record<string, string>) => void }) {
    const modules = useMemo(() => QUILL_MODULES, []);
    return (
        <ReactQuill
            theme="snow"
            value={data.html || ''}
            onChange={(val: string) => onChange({ ...data, html: val })}
            modules={modules}
            formats={QUILL_FORMATS}
            placeholder="Digite o texto..."
        />
    );
}

function ImageEditor({ data, onChange }: { data: Record<string, string>; onChange: (d: Record<string, string>) => void }) {
    const fileRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);

    const handleUpload = async (file: File) => {
        const formData = new FormData();
        formData.append('image', file);
        try {
            setUploading(true);
            const res = await api.post('/api/admin/upload-image', formData);
            onChange({ ...data, url: res.data.url });
        } catch {
            alert('Erro ao enviar imagem');
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="be-image-editor">
            {data.url ? (
                <div className="be-image-dropzone has-image" onClick={() => fileRef.current?.click()}>
                    <img src={resolveMediaUrl(data.url)} alt="Preview" />
                </div>
            ) : (
                <div className="be-image-dropzone" onClick={() => fileRef.current?.click()}>
                    <ImageIcon size={32} />
                    <span>{uploading ? 'Enviando...' : 'Clique para enviar imagem'}</span>
                </div>
            )}
            <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={e => { if (e.target.files?.[0]) handleUpload(e.target.files[0]); }}
            />
            <div className="be-image-controls">
                <input
                    className="be-image-caption-input"
                    value={data.caption || ''}
                    onChange={e => onChange({ ...data, caption: e.target.value })}
                    placeholder="Legenda da imagem (opcional)"
                />
                {['left', 'center', 'right'].map(a => (
                    <button
                        key={a}
                        className={`be-image-align-btn${(data.align || 'center') === a ? ' active' : ''}`}
                        onClick={() => onChange({ ...data, align: a })}
                    >
                        {a === 'left' ? '◀' : a === 'right' ? '▶' : '◆'}
                    </button>
                ))}
            </div>
        </div>
    );
}

function TwoColumnsEditor({ data, onChange }: { data: Record<string, string>; onChange: (d: Record<string, string>) => void }) {
    const modules = useMemo(() => QUILL_MODULES, []);
    return (
        <div className="be-two-cols-editor">
            <div className="be-col">
                <span className="be-col-label">Coluna Esquerda</span>
                <ReactQuill
                    theme="snow"
                    value={data.left || ''}
                    onChange={(val: string) => onChange({ ...data, left: val })}
                    modules={modules}
                    formats={QUILL_FORMATS}
                />
            </div>
            <div className="be-col">
                <span className="be-col-label">Coluna Direita</span>
                <ReactQuill
                    theme="snow"
                    value={data.right || ''}
                    onChange={(val: string) => onChange({ ...data, right: val })}
                    modules={modules}
                    formats={QUILL_FORMATS}
                />
            </div>
        </div>
    );
}

function BoxEditor({ data, onChange, accent }: { data: Record<string, string>; onChange: (d: Record<string, string>) => void; accent: string }) {
    const modules = useMemo(() => QUILL_MODULES, []);
    return (
        <div className="be-box-editor" style={{ borderLeftColor: accent }}>
            <input
                className="be-box-title-input"
                value={data.title || ''}
                onChange={e => onChange({ ...data, title: e.target.value })}
                placeholder="Título do bloco"
                style={{ color: accent }}
            />
            <ReactQuill
                theme="snow"
                value={data.html || ''}
                onChange={(val: string) => onChange({ ...data, html: val })}
                modules={modules}
                formats={QUILL_FORMATS}
            />
        </div>
    );
}

function FormulaEditor({ data, onChange }: { data: Record<string, string>; onChange: (d: Record<string, string>) => void }) {
    return (
        <input
            className="be-formula-input"
            value={data.text || ''}
            onChange={e => onChange({ ...data, text: e.target.value })}
            placeholder="f(x) = ax² + bx + c"
        />
    );
}

function HtmlCssEditor({ data, onChange }: { data: Record<string, string>; onChange: (d: Record<string, string>) => void }) {
    return (
        <div className="be-html-css-editor">
            <label className="be-col-label">HTML</label>
            <textarea
                className="be-code-area"
                value={data.html || ''}
                onChange={(e) => onChange({ ...data, html: e.target.value })}
                placeholder="<div>Seu HTML aqui</div>"
            />
            <label className="be-col-label">CSS (escopo local do bloco)</label>
            <textarea
                className="be-code-area"
                value={data.css || ''}
                onChange={(e) => onChange({ ...data, css: e.target.value })}
                placeholder=".classe { color: #0f172a; }"
            />
        </div>
    );
}

// ─── Main BlockEditor Component ───
export default function BlockEditor({ blocks, onChange }: BlockEditorProps) {
    const [showPalette, setShowPalette] = useState(false);
    const [previewMode, setPreviewMode] = useState(false);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    const handleDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        if (over && active.id !== over.id) {
            const oldIdx = blocks.findIndex(b => b.id === active.id);
            const newIdx = blocks.findIndex(b => b.id === over.id);
            onChange(arrayMove(blocks, oldIdx, newIdx));
        }
    }, [blocks, onChange]);

    const addBlock = (type: BlockType) => {
        const newBlock: ContentBlock = { id: uid(), type, data: createDefaultData(type) };
        onChange([...blocks, newBlock]);
        setShowPalette(false);
    };

    const updateBlock = (id: string, data: Record<string, string>) => {
        onChange(blocks.map(b => b.id === id ? { ...b, data } : b));
    };

    const deleteBlock = (id: string) => {
        onChange(blocks.filter(b => b.id !== id));
    };

    const renderBlockEditor = (block: ContentBlock) => {
        switch (block.type) {
            case 'heading':
                return <HeadingEditor data={block.data} onChange={d => updateBlock(block.id, d)} />;
            case 'text':
                return <TextEditor data={block.data} onChange={d => updateBlock(block.id, d)} />;
            case 'image':
                return <ImageEditor data={block.data} onChange={d => updateBlock(block.id, d)} />;
            case 'two-columns':
                return <TwoColumnsEditor data={block.data} onChange={d => updateBlock(block.id, d)} />;
            case 'highlight':
                return <BoxEditor data={block.data} onChange={d => updateBlock(block.id, d)} accent="#f59e0b" />;
            case 'example':
                return <BoxEditor data={block.data} onChange={d => updateBlock(block.id, d)} accent="#3b82f6" />;
            case 'solution':
                return <BoxEditor data={block.data} onChange={d => updateBlock(block.id, d)} accent="#10b981" />;
            case 'tip':
                return <BoxEditor data={block.data} onChange={d => updateBlock(block.id, d)} accent="#06b6d4" />;
            case 'warning':
                return <BoxEditor data={block.data} onChange={d => updateBlock(block.id, d)} accent="#ef4444" />;
            case 'formula':
                return <FormulaEditor data={block.data} onChange={d => updateBlock(block.id, d)} />;
            case 'html-css':
                return <HtmlCssEditor data={block.data} onChange={d => updateBlock(block.id, d)} />;
            default:
                return <p>Bloco desconhecido</p>;
        }
    };

    return (
        <div className="be-root">
            {/* Toggle bar */}
            <div className="be-toggle-bar">
                <button className="be-palette-btn" onClick={() => setShowPalette(!showPalette)}>
                    <Plus size={14} />
                    Adicionar Bloco
                    {showPalette ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
                <button
                    className={`be-toggle-btn ${previewMode ? 'active' : ''}`}
                    onClick={() => setPreviewMode(!previewMode)}
                >
                    {previewMode ? <Pencil size={14} /> : <Eye size={14} />}
                    {previewMode ? 'Editar' : 'Preview'}
                </button>
            </div>

            {/* Palette */}
            {showPalette && (
                <div className="be-palette">
                    {BLOCK_PALETTE.map(item => {
                        const Icon = item.icon;
                        return (
                            <button
                                key={item.type}
                                className="be-palette-btn"
                                onClick={() => addBlock(item.type)}
                            >
                                <Icon size={14} />
                                <span>{item.label}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Preview Mode */}
            {previewMode ? (
                <div className="be-preview">
                    <BlockRenderer blocks={blocks} />
                </div>
            ) : (
                /* Editor Mode */
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                    <SortableContext items={blocks.map(b => b.id)} strategy={verticalListSortingStrategy}>
                        <div className="be-blocks-list">
                            {blocks.length === 0 && (
                                <div className="be-empty">
                                    <Plus size={32} />
                                    <p>Clique em "Adicionar Bloco" para montar o conteúdo da aula</p>
                                </div>
                            )}
                            {blocks.map(block => (
                                <SortableBlock key={block.id} block={block} onDelete={() => deleteBlock(block.id)} onUpdate={d => updateBlock(block.id, d)}>
                                    {renderBlockEditor(block)}
                                </SortableBlock>
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>
            )}
        </div>
    );
}

// ─── Block Renderer (for LessonPage and Preview) ───
export function BlockRenderer({ blocks }: { blocks: ContentBlock[] }) {
    return (
        <div className="br-root">
            {blocks.map(block => (
                <div key={block.id} className="br-block">
                    {renderBlock(block)}
                </div>
            ))}
        </div>
    );
}

const BOX_LABELS: Record<string, string> = {
    highlight: '⚡ Destaque',
    example: '📖 Exemplo',
    solution: '✅ Resolução',
    tip: '💡 Dica',
    warning: '⚠️ Aviso',
};

function renderBlock(block: ContentBlock) {
    const background = /^#[0-9a-f]{3,8}$/i.test(block.data.bgColor || '') ? block.data.bgColor : undefined;
    const bgStyle = background ? { background, borderRadius: '10px', padding: '1.25rem' } : undefined;
    const blockScopeClass = `br-custom-${block.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const safeHtml = (value?: string) => DOMPurify.sanitize(value || '', {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'base', 'meta'],
        FORBID_ATTR: ['srcdoc']
    });

    switch (block.type) {
        case 'heading':
            return <h2 className="br-heading" style={bgStyle}>{block.data.text}</h2>;
        case 'text':
            return <div className="br-text" style={bgStyle} dangerouslySetInnerHTML={{ __html: safeHtml(block.data.html) }} />;
        case 'image': {
            const rawUrl = block.data.url || '';
            const isRelativeUpload = /^\/uploads\/images\/[a-zA-Z0-9._-]+$/.test(rawUrl);
            const isHttpImage = /^https?:\/\//i.test(rawUrl);
            const src = isRelativeUpload || isHttpImage ? resolveMediaUrl(rawUrl) : '';
            const align = block.data.align || 'center';
            return (
                <figure className={`br-image align-${align}`} style={bgStyle}>
                    {src && <img src={src} alt={block.data.caption || ''} loading="lazy" referrerPolicy="no-referrer" />}
                    {block.data.caption && <figcaption className="br-image-caption">{block.data.caption}</figcaption>}
                </figure>
            );
        }
        case 'two-columns':
            return (
                <div className="br-two-cols" style={bgStyle}>
                    <div dangerouslySetInnerHTML={{ __html: safeHtml(block.data.left) }} />
                    <div dangerouslySetInnerHTML={{ __html: safeHtml(block.data.right) }} />
                </div>
            );
        case 'highlight':
        case 'example':
        case 'solution':
        case 'tip':
        case 'warning': {
            const boxStyle = block.data.bgColor
                ? { ...bgStyle, borderLeft: `4px solid` }
                : undefined;
            return (
                <div className={`br-box ${block.type}`} style={boxStyle}>
                    <div className="br-box-label">{BOX_LABELS[block.type] || block.data.title}</div>
                    <div className="br-box-content" dangerouslySetInnerHTML={{ __html: safeHtml(block.data.html) }} />
                </div>
            );
        }
        case 'formula':
            return <div className="br-formula" style={bgStyle}>{block.data.text}</div>;
        case 'html-css': {
            const css = (block.data.css || '')
                .replace(/:host/g, `.${blockScopeClass}`)
                .replace(/:scope/g, `.${blockScopeClass}`)
                .replace(/@import[^;]+;?/gi, '')
                .replace(/url\s*\([^)]*\)/gi, '')
                .replace(/expression\s*\([^)]*\)/gi, '')
                .replace(/[<>]/g, '')
                .slice(0, 20_000);
            const document = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src data:"><style>html,body{margin:0;background:transparent;color:inherit;font-family:system-ui,sans-serif}${css}</style></head><body><div class="${blockScopeClass}">${safeHtml(block.data.html)}</div></body></html>`;

            return (
                <div style={bgStyle}>
                    <iframe
                        title="Conteúdo personalizado da aula"
                        sandbox=""
                        srcDoc={document}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        style={{ width: '100%', minHeight: '240px', border: 0, background: 'transparent' }}
                    />
                </div>
            );
        }
        default:
            return null;
    }
}

// ─── Helper: parse content field ───
// Content can be JSON (new block editor) or HTML (legacy Quill)
export function parseContentField(content: string | null): { isBlocks: boolean; blocks: ContentBlock[]; html: string } {
    if (!content) return { isBlocks: false, blocks: [], html: '' };
    try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type && parsed[0].id) {
            return { isBlocks: true, blocks: parsed, html: '' };
        }
    } catch {
        // not JSON → legacy HTML
    }
    return { isBlocks: false, blocks: [], html: content };
}
