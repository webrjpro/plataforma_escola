import DOMPurify from 'dompurify';
import { Edit3, Eye, Save, X } from 'lucide-react';
import BlockEditor, { BlockRenderer, type ContentBlock } from '../../../components/BlockEditor';

interface VideoEditorForm { title: string; description: string; content: string }

interface AdminVideoEditorProps {
    blocks: ContentBlock[];
    form: VideoEditorForm;
    mode: 'edit' | 'preview';
    onBlocksChange: (blocks: ContentBlock[]) => void;
    onClose: () => void;
    onFormChange: (form: VideoEditorForm) => void;
    onModeChange: (mode: 'edit' | 'preview') => void;
    onSave: () => void;
}

export function AdminVideoEditor({ blocks, form, mode, onBlocksChange, onClose, onFormChange, onModeChange, onSave }: AdminVideoEditorProps) {
    return (
        <div className="editor-modal-overlay" onClick={onClose}>
            <div className="editor-modal" onClick={event => event.stopPropagation()}>
                <div className="editor-modal-header">
                    <h2>Editar Aula</h2>
                    <div className="editor-modal-actions">
                        <div className="editor-modal-tabs">
                            <button className={`editor-modal-tab ${mode === 'edit' ? 'active' : ''}`} onClick={() => onModeChange('edit')}><Edit3 size={14} /> Editor</button>
                            <button className={`editor-modal-tab ${mode === 'preview' ? 'active' : ''}`} onClick={() => onModeChange('preview')}><Eye size={14} /> Visualizar como Aluno</button>
                        </div>
                        <button className="editor-modal-save" onClick={onSave}><Save size={14} /> Salvar</button>
                        <button className="editor-modal-close" onClick={onClose}><X size={18} /></button>
                    </div>
                </div>
                <div className="editor-modal-body">{mode === 'edit' ? (
                    <div className="editor-modal-edit"><div className="editor-modal-fields"><input value={form.title} onChange={event => onFormChange({ ...form, title: event.target.value })} placeholder="Título da aula" className="admin-input" /><input value={form.description} onChange={event => onFormChange({ ...form, description: event.target.value })} placeholder="Descrição" className="admin-input" /></div><BlockEditor blocks={blocks} onChange={onBlocksChange} /></div>
                ) : (
                    <div className="editor-modal-preview"><div className="lp-sheet"><h1 style={{ fontSize: '1.6rem', fontWeight: 700, color: '#1e293b', marginBottom: '1rem' }}>{form.title}</h1>{form.description && <p style={{ color: '#64748b', marginBottom: '1.5rem' }}>{form.description}</p>}{blocks.length > 0 ? <BlockRenderer blocks={blocks} /> : form.content ? <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(form.content) }} /> : <p style={{ color: '#94a3b8', fontStyle: 'italic' }}>Nenhum conteúdo adicionado ainda.</p>}</div></div>
                )}</div>
            </div>
        </div>
    );
}
