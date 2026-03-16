/**
 * @author Yassine Ahaggach
 * @description Document AI LWC — upload or pick a file, define an extraction schema,
 *              and get structured field-level results powered by Salesforce Data Cloud.
 */
import { LightningElement, track } from 'lwc';
import getAvailableFiles from '@salesforce/apex/DocAINativeController.getAvailableFiles';
import getGlobalConfig   from '@salesforce/apex/DocAINativeController.getGlobalConfig';
import generateSchema    from '@salesforce/apex/DocAINativeController.generateSchema';
import extractData       from '@salesforce/apex/DocAINativeController.extractData';

// ── helpers ────────────────────────────────────────────────────────────────

function getFileIcon(fileType) {
    switch (fileType) {
        case 'PDF':   return 'doctype:pdf';
        case 'PNG':
        case 'JPG':
        case 'JPEG':  return 'doctype:image';
        case 'EXCEL': return 'doctype:excel';
        case 'POWER_POINT': return 'doctype:ppt';
        default:      return 'doctype:unknown';
    }
}

// Decode HTML entities for use OUTSIDE of a JSON string context
// (e.g. when the entire JSON is HTML-encoded and we need bare " for JSON.parse).
const htmlDecode = str =>
    str.replace(/&quot;/g, '"')
       .replace(/&amp;/g,  '&')
       .replace(/&#39;/g,  "'")
       .replace(/&lt;/g,   '<')
       .replace(/&gt;/g,   '>')
       .replace(/&#92;/g,  '\\')
       .replace(/&#10;/g,  '\n')
       .replace(/&#13;/g,  '\r');

// Decode HTML entities for use INSIDE an already-parsed JSON string value.
// &quot; must become \" (JSON-escaped) so it doesn't break sibling JSON structure.
const htmlDecodeInJsonString = str =>
    str.replace(/&quot;/g, '\\"')
       .replace(/&amp;/g,  '&')
       .replace(/&#39;/g,  "'")
       .replace(/&lt;/g,   '<')
       .replace(/&gt;/g,   '>')
       .replace(/&#92;/g,  '\\')
       .replace(/&#10;/g,  '\n')
       .replace(/&#13;/g,  '\r');

// Smart decoder: ALL quotes (structural + content) are &quot; in the API response.
// Structural &quot; → "   (opening/closing a JSON string)
// Content  &quot; → \"  (literal quote inside a string value)
// Heuristic: a &quot; while inside a string is "closing" if the first
// non-whitespace character after it is  :  ,  }  ]  or end-of-input.
function decodeHtmlEncodedJsonSmart(encoded) {
    const len = encoded.length;
    let out = '';
    let i = 0;
    let inString = false;

    while (i < len) {
        if (encoded.slice(i, i + 6) === '&quot;') {
            if (!inString) {
                inString = true;
                out += '"';
                i += 6;
            } else {
                let j = i + 6;
                while (j < len && ' \t\r\n'.includes(encoded[j])) j++;
                const nxt = j < len ? encoded[j] : '';
                if (nxt === '' || nxt === ':' || nxt === ',' || nxt === '}' || nxt === ']') {
                    inString = false;
                    out += '"';
                } else {
                    out += '\\"';
                }
                i += 6;
            }
        } else if (encoded.slice(i, i + 5) === '&amp;') {
            out += '&'; i += 5;
        } else if (encoded.slice(i, i + 4) === '&lt;') {
            out += '<'; i += 4;
        } else if (encoded.slice(i, i + 4) === '&gt;') {
            out += '>'; i += 4;
        } else if (encoded.slice(i, i + 5) === '&#39;') {
            out += "'"; i += 5;
        } else if (encoded.slice(i, i + 5) === '&#92;') {
            // HTML-encoded backslash — keep as \ so the following char completes
            // the JSON escape sequence (e.g. &#92;n → \n → actual newline after parse)
            out += '\\'; i += 5;
        } else if (encoded.slice(i, i + 5) === '&#10;') {
            out += inString ? '\\n' : '\n'; i += 5;
        } else if (encoded.slice(i, i + 5) === '&#13;') {
            out += inString ? '\\r' : '\r'; i += 5;
        } else {
            out += encoded[i]; i++;
        }
    }
    return out;
}

// Returns a diagnostic snapshot around a JSON parse failure position.
function jsonDiag(label, str, err) {
    // Modern V8 exposes position on the error object; older engines only put it
    // in the message string — parse both.
    let pos = err && typeof err.position === 'number' ? err.position : -1;
    if (pos === -1 && err && err.message) {
        const m = err.message.match(/at position (\d+)/);
        if (m) pos = parseInt(m[1], 10);
    }
    const start   = Math.max(0, pos - 120);
    const end     = Math.min(str.length, pos + 120);
    const snippet = pos >= 0 ? str.slice(start, end) : '(position unknown)';
    const arrow   = pos >= 0 ? ' '.repeat(Math.min(120, pos - start)) + '^^^' : '';
    const info = {
        strategy:      label,
        error:         err ? err.message : 'unknown',
        failPosition:  pos,
        totalLength:   str.length,
        charAtPos:     pos >= 0 ? JSON.stringify(str[pos]) : null,
        charCodeAtPos: pos >= 0 ? str.charCodeAt(pos) : null,
        snippet,
        arrow,
        first200:      str.slice(0, 200),
        last200:       str.slice(-200),
        hasHtmlEntities: /&(?:quot|amp|lt|gt|#39);/.test(str),
    };
    // eslint-disable-next-line no-console
    console.error('[DocAI parseExtractionData]', label, '\n', JSON.stringify(info, null, 2));
    return info;
}

// Parse the outer API response wrapper, which can itself be malformed if the
// API embeds unescaped quotes inside string values.
function parseOuterResponse(raw) {
    // Strategy 1: straight parse
    try { return JSON.parse(raw); } catch (e1) { jsonDiag('outer: JSON.parse', raw, e1); }

    // Strategy 2: HTML-decode the whole thing first
    try { return JSON.parse(htmlDecode(raw)); } catch (e2) { jsonDiag('outer: htmlDecode→JSON.parse', htmlDecode(raw), e2); }

    // Strategy 3: replace &quot; with \" (keep them escaped as JSON inner-string quotes)
    try { return JSON.parse(htmlDecodeInJsonString(raw)); } catch (e3) {
        const d = jsonDiag('outer: htmlDecodeInJsonString→JSON.parse', htmlDecodeInJsonString(raw), e3);
        throw new Error(
            'Cannot parse Document AI API response (tried 3 strategies). ' +
            'Pos=' + d.failPosition + ' char=' + d.charAtPos + '(' + d.charCodeAtPos + ')' +
            '\nSnippet: ...' + d.snippet + '...'
        );
    }
}

// Robustly parse the inner extraction-data JSON and return a rich diagnostic
// error if every strategy fails so the caller can surface it to the user.
function parseExtractionData(encoded) {
    const diags = [];

    // Strategy A: smart HTML-decode — structural &quot;→" and content &quot;→\"
    // This is the primary strategy for the Document AI API which HTML-encodes ALL
    // quotes (including those inside text values like "the "Client" agrees").
    try {
        return JSON.parse(decodeHtmlEncodedJsonSmart(encoded));
    } catch (e) {
        diags.push(jsonDiag('A: smartDecode → JSON.parse', decodeHtmlEncodedJsonSmart(encoded), e));
    }

    // Strategy B: JSON.parse the raw string directly (API returned valid JSON)
    // then decode any HTML entities left inside string values.
    try {
        const raw = JSON.parse(encoded);
        return decodeEntitiesInObject(raw);
    } catch (e) {
        diags.push(jsonDiag('B: JSON.parse → walk+decode', encoded, e));
    }

    // Strategy C: plain htmlDecode first, then JSON.parse
    // Works when the JSON is HTML-encoded but text values have no bare quotes.
    try {
        return JSON.parse(htmlDecode(encoded));
    } catch (e) {
        diags.push(jsonDiag('C: htmlDecode → JSON.parse', htmlDecode(encoded), e));
    }

    // Strategy D: replace &quot; with \" throughout, then JSON.parse
    try {
        return JSON.parse(htmlDecodeInJsonString(encoded));
    } catch (e) {
        diags.push(jsonDiag('D: htmlDecodeInJsonString → JSON.parse', htmlDecodeInJsonString(encoded), e));
    }

    // All strategies failed — build a human-readable diagnostic for the UI
    const summary = diags.map(d =>
        `[${d.strategy}] pos=${d.failPosition} len=${d.totalLength} char=${d.charAtPos}(${d.charCodeAtPos})\n` +
        `  snippet: ...${d.snippet}...\n` +
        `         : ...${d.arrow}...\n` +
        `  first200: ${d.first200}\n` +
        `  hasEntities: ${d.hasHtmlEntities}`
    ).join('\n\n');

    throw new Error(
        'JSON parse failed after 4 strategies. Copy the diagnostic below and share it:\n\n' + summary
    );
}

function decodeEntitiesInObject(obj) {
    if (typeof obj === 'string') return htmlDecode(obj);
    if (Array.isArray(obj))     return obj.map(decodeEntitiesInObject);
    if (obj && typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = decodeEntitiesInObject(v);
        return out;
    }
    return obj;
}

const camelToLabel = key =>
    key.replace(/([A-Z])/g, ' $1')
       .replace(/^./, s => s.toUpperCase())
       .replace(/_/g, ' ');

const formatNumber = n =>
    typeof n === 'number' ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(n);

const formatSize = bytes => {
    if (!bytes) return '';
    const kb = bytes / 1024;
    return kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb.toFixed(0) + ' KB';
};

const confInfo = score => {
    if (score === null || score === undefined) return { cls: 'conf-na',   lbl: 'N/A',  title: 'No confidence score' };
    const pct = Math.round(score * 100);
    if (pct >= 90) return { cls: 'conf-high', lbl: pct + '%', title: 'High confidence' };
    if (pct >= 70) return { cls: 'conf-med',  lbl: pct + '%', title: 'Medium confidence' };
    return              { cls: 'conf-low',  lbl: pct + '%', title: 'Low confidence' };
};

const TYPE_BADGES = {
    string:         'type-badge type-string',
    number:         'type-badge type-number',
    boolean:        'type-badge type-bool',
    array_strings:  'type-badge type-array',
    array_objects:  'type-badge type-array',
    array:          'type-badge type-array',
    object:         'type-badge type-object',
};

const TYPE_LABELS = {
    string:        'string',
    number:        'number',
    boolean:       'boolean',
    array_strings: 'array[ ]',
    array_objects: 'array[{ }]',
};

let _fieldIdCounter = 1;

// ── schema ↔ field-list conversion ────────────────────────────────────────

function buildSchemaFromFields(fields) {
    const props = {};
    for (const f of fields) {
        if (!f.name) continue;
        let def;
        if (f.type === 'array_strings') {
            def = { type: 'array', items: { type: 'string' } };
        } else if (f.type === 'array_objects') {
            const subProps = {};
            for (const col of (f.columns || [])) {
                if (!col.name) continue;
                subProps[col.name] = { type: col.type || 'string' };
            }
            def = { type: 'array', items: { type: 'object', properties: subProps } };
        } else {
            def = { type: f.type || 'string' };
        }
        if (f.description) def.description = f.description;
        props[f.name] = def;
    }
    return { type: 'object', properties: props };
}

function fieldsFromSchema(schema) {
    if (!schema || schema.type !== 'object' || !schema.properties) return [];
    return Object.entries(schema.properties).map(([name, def]) => {
        let type = def.type || 'string';
        let columns = [];
        if (type === 'array') {
            if (def.items && def.items.type === 'object') {
                type = 'array_objects';
                if (def.items.properties) {
                    columns = Object.entries(def.items.properties).map(([cName, cDef]) => ({
                        id:            _fieldIdCounter++,
                        name:          cName,
                        type:          cDef.type || 'string',
                        typeBadgeClass: TYPE_BADGES[cDef.type] || 'type-badge',
                    }));
                }
            } else {
                type = 'array_strings';
            }
        }
        return {
            id:             _fieldIdCounter++,
            name,
            type,
            typeLabel:      TYPE_LABELS[type] || type,
            description:    def.description || '',
            typeBadgeClass: TYPE_BADGES[type] || 'type-badge',
            isArrayObjects: type === 'array_objects',
            hasColumns:     columns.length > 0,
            columns,
        };
    });
}

// ── result field builder ───────────────────────────────────────────────────

// schemaOrder: ordered array of field key names from the loaded schema.
// Fields not found in the schema order appear at the end in their original order.
function buildResultFields(dataObj, schemaOrder) {
    const fields = [];
    let idx = 0;
    for (const [key, field] of Object.entries(dataObj)) {
        const label  = camelToLabel(key);
        const conf   = confInfo(field.confidence_score);
        const isArr  = field.type === 'array';
        const isNull = field.value === null || field.value === undefined;

        if (isArr) {
            const rawItems = (field.value || []).filter(
                item => item && item.value && typeof item.value === 'object'
                     && Object.values(item.value).some(v => v.value !== null)
            );
            const primitiveItems = (field.value || []).filter(
                item => item && item.value !== null && typeof item.value !== 'object'
            ).map((item, i) => ({ key: String(i), value: String(item.value) }));
            const isPrimitive = rawItems.length === 0 && primitiveItems.length > 0;

            const tableData  = [];
            const colSet     = [];
            const seenCols   = new Set();
            rawItems.forEach((item, i) => {
                const row = { __rowIndex: String(i) };
                for (const [k, v] of Object.entries(item.value)) {
                    if (v.value !== null && v.value !== undefined) {
                        row[k] = v.type === 'number' ? formatNumber(v.value) : String(v.value);
                        if (!seenCols.has(k)) {
                            seenCols.add(k);
                            colSet.push({ label: camelToLabel(k), fieldName: k, wrapText: true });
                        }
                    }
                }
                tableData.push(row);
            });

            fields.push({
                key:              key + '_' + idx++,
                _srcKey:          key,
                label,
                icon:             'utility:list',
                isScalar:         false,
                isArray:          true,
                isPrimitiveArray: isPrimitive,
                primitiveItems,
                colClass:         'res-col res-col-full',
                cardClass:        'res-card',
                confClass:        conf.cls,
                confLabel:        conf.lbl,
                confTitle:        conf.title,
                itemCount:        isPrimitive ? primitiveItems.length : tableData.length,
                itemLabel:        (isPrimitive ? primitiveItems.length : tableData.length) === 1 ? 'item' : 'items',
                isExpanded:       false,
                expandIcon:       'utility:chevrondown',
                tableData,
                tableColumns:     colSet,
            });
        } else {
            const rawVal     = isNull ? null : field.value;
            const isNumeric  = field.type === 'number' && rawVal !== null;
            const displayVal = isNull ? '—' : isNumeric ? formatNumber(rawVal) : String(rawVal);
            const isLong     = !isNull && typeof rawVal === 'string' && rawVal.length > 200;
            fields.push({
                key:          key + '_' + idx++,
                _srcKey:      key,
                label,
                icon:         field.type === 'number'  ? 'utility:number_input'
                            : field.type === 'boolean' ? 'utility:check'
                            :                            'utility:text',
                isScalar:     true,
                isArray:      false,
                colClass:     isLong ? 'res-col res-col-full' : 'res-col res-col-half',
                cardClass:    isNull ? 'res-card res-card_null' : 'res-card',
                confClass:    conf.cls,
                confLabel:    conf.lbl,
                confTitle:    conf.title,
                displayValue: displayVal,
                valClass:     isNull ? 'res-val res-val_null' : isLong ? 'res-val_long' : 'res-val',
            });
        }
    }
    // Sort by schema order when available; unrecognised keys appear at the end.
    if (schemaOrder && schemaOrder.length) {
        fields.sort((a, b) => {
            const ai = schemaOrder.indexOf(a._srcKey);
            const bi = schemaOrder.indexOf(b._srcKey);
            return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
        });
    }
    return fields;
}

// ── component ──────────────────────────────────────────────────────────────

export default class DocAINative extends LightningElement {

    // steps
    currentStep = 1;

    // files — backing store; UI reads via the pagedFiles getter
    @track _allFiles = [];
    filesLoading     = true;
    fileSearchTerm   = '';
    fileTypeFilter   = 'PDF';
    currentPage      = 1;
    pageSize         = 12;
    selectedVersionId  = null;
    selectedDocumentId = null;
    selectedFileTitle  = '';

    // model
    @track modelOptions = [];
    selectedModel = '';
    get selectedModelLabel() {
        const opt = this.modelOptions.find(o => o.value === this.selectedModel);
        return opt ? opt.label : this.selectedModel;
    }

    // schema
    schemaJson    = '';
    @track schemaFields   = [];
    schemaError   = '';
    schemaLoading = false;
    newFieldName  = '';
    newFieldType  = 'string';

    // non-reactive buffers for column add-form inputs (one per field, keyed by fieldId)
    _newColNames = {};
    _newColTypes = {};

    // extraction
    isLoading       = false;
    extractionError = '';
    @track resultFields = [];
    resultsMetaLabel = '';
    _lastRawData     = null;

    // ── lifecycle ────────────────────────────────────────────────────────

    connectedCallback() {
        this._loadFiles();
        this._loadGlobalConfig();
    }

    _loadFiles() {
        this.filesLoading = true;
        getAvailableFiles()
            .then(files => {
                this._allFiles = files.map(f => ({
                    ...f,
                    isSelected: false,
                    cardClass:  'file-card',
                    iconName:   getFileIcon(f.fileType),
                    sizeLabel:  formatSize(Number(f.size)),
                }));
            })
            .catch(() => { this._allFiles = []; })
            .finally(() => { this.filesLoading = false; });
    }

    _loadGlobalConfig() {
        getGlobalConfig()
            .then(raw => {
                const config = JSON.parse(raw);
                this.modelOptions = config.supportedModels
                    .filter(m => m.status === 'ENABLED')
                    .map(m => ({ label: m.label + ' (' + m.provider + ')', value: m.id }));
                if (this.modelOptions.length > 0) {
                    this.selectedModel = this.modelOptions[0].value;
                }
            })
            .catch(() => {
                this.modelOptions = [
                    { label: 'OpenAI GPT-4o', value: 'OpenAIGPT4Omni' },
                    { label: 'Gemini 2.5 Flash', value: 'VertexAIGemini25Flash' },
                ];
                this.selectedModel = 'OpenAIGPT4Omni';
            });
    }

    // ── step getters ─────────────────────────────────────────────────────

    get isStep1() { return this.currentStep === 1; }
    get isStep2() { return this.currentStep === 2; }
    get isStep3() { return this.currentStep === 3; }

    get step1Class() { return this._stepClass(1); }
    get step2Class() { return this._stepClass(2); }
    get step3Class() { return this._stepClass(3); }
    _stepClass(n) {
        if (this.currentStep === n) return 'step step-active';
        if (this.currentStep >  n) return 'step step-done';
        return 'step step-pending';
    }

    // ── navigation ───────────────────────────────────────────────────────

    goStep1() { this.currentStep = 1; }
    goStep2() { if (this.selectedVersionId) this.currentStep = 2; }
    goStep3() { this.currentStep = 3; }

    // ── file selection ───────────────────────────────────────────────────

    get noFileSelected() { return !this.selectedVersionId; }

    get fileTypeOptions() {
        const types = [
            { label: 'All',         value: 'ALL' },
            { label: 'PDF',         value: 'PDF' },
            { label: 'Image',       value: 'IMAGE' },
            { label: 'Excel',       value: 'EXCEL' },
            { label: 'PowerPoint',  value: 'PPTX' },
        ];
        return types.map(o => ({
            ...o,
            pillClass: o.value === this.fileTypeFilter
                ? 'type-pill type-pill_active'
                : 'type-pill',
        }));
    }

    // filtered (search + type) — source for pagination
    get filteredFiles() {
        const search = (this.fileSearchTerm || '').toLowerCase().trim();
        const type   = this.fileTypeFilter;
        return this._allFiles.filter(f => {
            if (type === 'PDF'   && f.fileType !== 'PDF') return false;
            if (type === 'IMAGE' && !['PNG', 'JPG', 'JPEG'].includes(f.fileType)) return false;
            if (type === 'EXCEL' && f.fileType !== 'EXCEL') return false;
            if (type === 'PPTX'  && f.fileType !== 'POWER_POINT') return false;
            if (search && !(f.title || '').toLowerCase().includes(search)) return false;
            return true;
        });
    }

    // current page slice — what the grid renders
    get availableFiles() {
        const start = (this.currentPage - 1) * this.pageSize;
        return this.filteredFiles.slice(start, start + this.pageSize);
    }

    get totalPages() {
        return Math.max(1, Math.ceil(this.filteredFiles.length / this.pageSize));
    }

    get hasPrevPage()  { return this.currentPage > 1; }
    get hasNextPage()  { return this.currentPage < this.totalPages; }
    get noPrevPage()   { return !this.hasPrevPage; }
    get noNextPage()   { return !this.hasNextPage; }

    get pageItems() {
        const total = this.totalPages;
        const curr  = this.currentPage;
        if (total <= 7) {
            return Array.from({ length: total }, (_, i) => ({
                n: i + 1, label: String(i + 1), isEllipsis: false, isCurrent: i + 1 === curr,
                btnClass: i + 1 === curr ? 'pg-btn pg-btn_active' : 'pg-btn',
            }));
        }
        const show = new Set([1, total]);
        for (let i = Math.max(1, curr - 2); i <= Math.min(total, curr + 2); i++) show.add(i);
        const sorted = [...show].sort((a, b) => a - b);
        const items = [];
        sorted.forEach((n, idx) => {
            if (idx > 0 && n > sorted[idx - 1] + 1) {
                items.push({ n: -(idx * 100), label: '…', isEllipsis: true, isCurrent: false, btnClass: 'pg-ellipsis' });
            }
            items.push({ n, label: String(n), isEllipsis: false, isCurrent: n === curr, btnClass: n === curr ? 'pg-btn pg-btn_active' : 'pg-btn' });
        });
        return items;
    }

    get fileCountLabel() {
        const filtered = this.filteredFiles.length;
        const total    = this._allFiles.length;
        const start    = Math.min((this.currentPage - 1) * this.pageSize + 1, filtered);
        const end      = Math.min(this.currentPage * this.pageSize, filtered);
        if (filtered === 0) return 'No files match';
        const range = filtered > this.pageSize ? `${start}–${end} of ` : '';
        return filtered === total
            ? `${range}${filtered} file${filtered !== 1 ? 's' : ''}`
            : `${range}${filtered} of ${total} files`;
    }

    handleFileSearchChange(event) {
        this.fileSearchTerm = event.target.value;
        this.currentPage = 1;
    }

    handleFileTypeFilter(event) {
        this.fileTypeFilter = event.currentTarget.dataset.value;
        this.currentPage = 1;
    }

    handlePrevPage() { if (this.hasPrevPage) this.currentPage -= 1; }
    handleNextPage() { if (this.hasNextPage) this.currentPage += 1; }
    handleGoToPage(event) {
        const n = Number(event.currentTarget.dataset.page);
        if (n >= 1 && n <= this.totalPages) this.currentPage = n;
    }

    selectFile(event) {
        const vid   = event.currentTarget.dataset.vid;
        const did   = event.currentTarget.dataset.did;
        const title = event.currentTarget.dataset.title;
        this.selectedVersionId  = vid;
        this.selectedDocumentId = did;
        this.selectedFileTitle  = title;
        this._allFiles = this._allFiles.map(f => ({
            ...f,
            isSelected: f.versionId === vid,
            cardClass:  f.versionId === vid ? 'file-card file-card_selected' : 'file-card',
        }));
    }

    handleUploadFinished(event) {
        const uploaded = event.detail.files[0];
        if (!uploaded) return;
        const title = uploaded.name.replace(/\.[^/.]+$/, '');
        const newFile = {
            versionId:   uploaded.contentVersionId,
            documentId:  uploaded.documentId,
            title,
            fileType:    'PDF',
            sizeLabel:   '',
            isSelected:  true,
            cardClass:   'file-card file-card_selected',
            iconName:    'doctype:pdf',
        };
        this._allFiles = [
            ...this._allFiles.map(f => ({ ...f, isSelected: false, cardClass: 'file-card' })),
            newFile,
        ];
        this.selectedVersionId  = uploaded.contentVersionId;
        this.selectedDocumentId = uploaded.documentId;
        this.selectedFileTitle  = title;
    }

    // ── model ────────────────────────────────────────────────────────────

    handleModelChange(event) { this.selectedModel = event.detail.value; }

    // ── field description handler ─────────────────────────────────────────

    handleFieldDescChange(event) {
        const fid  = Number(event.currentTarget.dataset.id);
        const desc = event.target.value;
        this.schemaFields = this.schemaFields.map(f =>
            f.id === fid ? { ...f, description: desc } : f
        );
        this._syncJsonFromFields();
    }

    // ── column handlers ───────────────────────────────────────────────────

    handleNewColName(event) {
        const fid = Number(event.currentTarget.dataset.colNameFid);
        this._newColNames[fid] = event.target.value;
    }

    handleNewColType(event) {
        const fid = Number(event.currentTarget.dataset.colTypeFid);
        this._newColTypes[fid] = event.target.value;
    }

    addColumn(event) {
        const fid  = Number(event.currentTarget.dataset.fid);
        const name = (this._newColNames[fid] || '').trim();
        const type = this._newColTypes[fid] || 'string';
        if (!name) return;
        this.schemaFields = this.schemaFields.map(f => {
            if (f.id !== fid) return f;
            const newCol = {
                id:             _fieldIdCounter++,
                name,
                type,
                typeBadgeClass: TYPE_BADGES[type] || 'type-badge',
            };
            const cols = [...(f.columns || []), newCol];
            return { ...f, columns: cols, hasColumns: true };
        });
        this._newColNames[fid] = '';
        // clear the input element
        const inp = this.template.querySelector(`[data-col-name-fid="${fid}"]`);
        if (inp) inp.value = '';
        this._syncJsonFromFields();
    }

    removeColumn(event) {
        const fid = Number(event.currentTarget.dataset.fid);
        const cid = Number(event.currentTarget.dataset.cid);
        this.schemaFields = this.schemaFields.map(f => {
            if (f.id !== fid) return f;
            const cols = f.columns.filter(c => c.id !== cid);
            return { ...f, columns: cols, hasColumns: cols.length > 0 };
        });
        this._syncJsonFromFields();
    }

    // ── schema field builder ─────────────────────────────────────────────

    get hasSchemaFields() { return this.schemaFields.length > 0; }
    get schemaFieldCount() { return this.schemaFields.length; }
    get noNewFieldName()   { return !this.newFieldName.trim(); }

    handleNewFieldName(event) { this.newFieldName = event.target.value; }
    handleNewFieldType(event) { this.newFieldType = event.target.value; }

    addField() {
        const name = this.newFieldName.trim();
        if (!name) return;
        const type = this.newFieldType || 'string';
        this.schemaFields = [
            ...this.schemaFields,
            {
                id:             _fieldIdCounter++,
                name,
                type,
                typeLabel:      TYPE_LABELS[type] || type,
                description:    '',
                typeBadgeClass: TYPE_BADGES[type] || 'type-badge',
                isArrayObjects: type === 'array_objects',
                hasColumns:     false,
                columns:        [],
            },
        ];
        this.newFieldName = '';
        this._syncJsonFromFields();
    }

    removeField(event) {
        const id = Number(event.currentTarget.dataset.id);
        this.schemaFields = this.schemaFields.filter(f => f.id !== id);
        this._syncJsonFromFields();
    }

    _syncJsonFromFields() {
        try {
            const schema = buildSchemaFromFields(this.schemaFields);
            this.schemaJson  = JSON.stringify(schema, null, 2);
            this.schemaError = '';
        } catch (e) {
            this.schemaError = e.message;
        }
    }

    // ── schema JSON editor ───────────────────────────────────────────────

    get noSchema()         { return !this.schemaJson.trim(); }
    get schemaValid()      { return !this.schemaError && !!this.schemaJson.trim(); }
    get schemaPlaceholder(){ return '{"type":"object","properties":{"field_name":{"type":"string","description":"Extraction hint..."}}}'; }

    handleSchemaInput(event) {
        this.schemaJson = event.target.value;
        this._validateAndSyncFields(this.schemaJson);
    }

    _validateAndSyncFields(json) {
        if (!json.trim()) { this.schemaError = ''; this.schemaFields = []; return; }
        try {
            const parsed = JSON.parse(json);
            this.schemaError = '';
            this.schemaFields = fieldsFromSchema(parsed);
        } catch (e) {
            this.schemaError = 'Invalid JSON: ' + e.message;
        }
    }

    // ── schema generation ────────────────────────────────────────────────

    generateSchemaFromFile() {
        this.schemaLoading = true;
        this.schemaError   = '';
        generateSchema({ fileVersionId: this.selectedVersionId, mlModel: this.selectedModel })
            .then(raw => {
                const outer     = JSON.parse(raw);
                const decoded   = htmlDecode(outer.schema || '{}');
                const schema    = JSON.parse(decoded);
                this.schemaJson = JSON.stringify(schema, null, 2);
                this.schemaFields = fieldsFromSchema(schema);
            })
            .catch(err => {
                this.schemaError = err.body ? err.body.message : err.message;
            })
            .finally(() => { this.schemaLoading = false; });
    }

    // ── schema upload ────────────────────────────────────────────────────

    triggerSchemaUpload() {
        this.template.querySelector('[data-id="schema-upload"]').click();
    }

    handleSchemaFileUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
            try {
                const parsed      = JSON.parse(e.target.result);
                this.schemaJson   = JSON.stringify(parsed, null, 2);
                this.schemaFields = fieldsFromSchema(parsed);
                this.schemaError  = '';
            } catch (err) {
                this.schemaError = 'Invalid JSON file: ' + err.message;
            }
        };
        reader.readAsText(file);
        event.target.value = '';
    }

    // ── schema download ───────────────────────────────────────────────────

    downloadSchema() {
        if (!this.schemaJson) return;
        const blob = new Blob([this.schemaJson], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = 'schema.json'; a.click();
        URL.revokeObjectURL(url);
    }

    clearSchema() {
        this.schemaJson   = '';
        this.schemaFields = [];
        this.schemaError  = '';
    }

    // ── extraction ────────────────────────────────────────────────────────

    get cantExtract() {
        return !this.selectedVersionId || !this.selectedModel || !this.schemaValid || this.isLoading;
    }

    runExtraction() {
        this.currentStep     = 3;
        this.isLoading       = true;
        this.extractionError = '';
        this.resultFields    = [];

        extractData({
            fileVersionId: this.selectedVersionId,
            mlModel:       this.selectedModel,
            schemaConfig:  this.schemaJson,
        })
        .then(raw => {
            // ── Step 1: parse outer API response wrapper ──────────────────
            // eslint-disable-next-line no-console
            console.log('[DocAI] raw len:', raw.length,
                        '| hasEntities:', /&(?:quot|amp|lt|gt|#39);/.test(raw),
                        '| first300:', raw.slice(0, 300));

            const outer = parseOuterResponse(raw);

            // If Apex couldn't parse the raw body, surface the diagnostic
            if (outer.parseError) {
                throw new Error(
                    'Apex could not parse the Document AI response. ' +
                    'parseError: ' + outer.parseError +
                    '\nrawBody (first 2000 chars): ' + outer.rawBody
                );
            }

            // ── Step 2: get the inner encoded payload ─────────────────────
            const slot = outer.data && outer.data[0] ? outer.data[0] : null;
            if (!slot) throw new Error('Empty response from Document AI API.');

            // `slot.data` may already be a JS object (API embeds it directly)
            // or a string that needs further parsing / HTML-decoding.
            let dataObj;
            if (slot.data && typeof slot.data === 'object') {
                dataObj = slot.data;
            } else if (typeof slot.data === 'string' && slot.data.trim()) {
                dataObj = parseExtractionData(slot.data);
            } else {
                throw new Error('No extraction data payload in API response.');
            }

            this._lastRawData    = dataObj;
            this.resultFields    = buildResultFields(dataObj, this.schemaFields.map(f => f.name));
            const meta           = slot.metadata || {};
            this.resultsMetaLabel = [
                this.selectedFileTitle,
                this.selectedModelLabel,
                meta.filePages ? meta.filePages + ' pages' : '',
            ].filter(Boolean).join('  ·  ');
        })
        .catch(err => {
            this.extractionError = err.body ? err.body.message : (err.message || 'Extraction failed.');
        })
        .finally(() => { this.isLoading = false; });
    }

    // ── download ──────────────────────────────────────────────────────────

    get canDownload()  { return !!this._lastRawData && !this.isLoading; }
    get cantDownload() { return !this._lastRawData || this.isLoading; }

    downloadJson() {
        if (!this._lastRawData) return;
        const payload = {
            file:        this.selectedFileTitle,
            model:       this.selectedModelLabel,
            extractedAt: new Date().toISOString(),
            data:        this._cleanDataWithConfidence(),
        };
        const fname = this._safeFilename(this.selectedFileTitle, 'json');
        this._triggerDownload(JSON.stringify(payload, null, 2), 'application/json', fname);
    }

    downloadCsv() {
        if (!this._lastRawData) return;
        const fname = this._safeFilename(this.selectedFileTitle, 'csv');
        this._triggerDownload('\uFEFF' + this._buildCsv(), 'text/csv;charset=utf-8;', fname);
    }

    // Flat values only — used internally by CSV builder
    _cleanData() {
        const out = {};
        for (const [key, field] of Object.entries(this._lastRawData)) {
            if (field.type === 'array') {
                out[key] = (field.value || []).map(item => {
                    if (item && item.value && typeof item.value === 'object') {
                        const row = {};
                        for (const [k, v] of Object.entries(item.value)) {
                            if (v && v.value !== null && v.value !== undefined) row[k] = v.value;
                        }
                        return row;
                    }
                    return (item && item.value !== null) ? item.value : null;
                }).filter(x => x !== null);
            } else {
                out[key] = field.value !== undefined ? field.value : null;
            }
        }
        return out;
    }

    // Structured export — each field carries its value AND confidence score
    _cleanDataWithConfidence() {
        const out = {};
        for (const [key, field] of Object.entries(this._lastRawData)) {
            const conf = (field.confidence_score !== null && field.confidence_score !== undefined)
                ? field.confidence_score : null;

            if (field.type === 'array') {
                const rows = (field.value || []).map(item => {
                    if (item && item.value && typeof item.value === 'object') {
                        const row = {};
                        for (const [k, v] of Object.entries(item.value)) {
                            if (v && v.value !== null && v.value !== undefined) {
                                row[k] = {
                                    value:            v.value,
                                    confidence_score: v.confidence_score ?? null,
                                };
                            }
                        }
                        return row;
                    }
                    return (item && item.value !== null) ? { value: item.value, confidence_score: item.confidence_score ?? null } : null;
                }).filter(x => x !== null);
                out[key] = { value: rows, confidence_score: conf };
            } else {
                out[key] = {
                    value:            field.value !== undefined ? field.value : null,
                    confidence_score: conf,
                };
            }
        }
        return out;
    }

    _buildCsv() {
        const csvCell = val => {
            const s = String(val === null || val === undefined ? '' : val).replace(/"/g, '""');
            return (s.includes(',') || s.includes('\n') || s.includes('"')) ? `"${s}"` : s;
        };
        const rows = [['Field', 'Value', 'Confidence Score']];

        for (const [key, field] of Object.entries(this._lastRawData)) {
            const conf = (field.confidence_score !== null && field.confidence_score !== undefined)
                ? Math.round(field.confidence_score * 100) + '%' : '';

            if (field.type === 'array') {
                const items = field.value || [];
                if (items.length === 0) {
                    rows.push([key, '', conf]);
                } else if (items[0] && typeof items[0].value === 'object') {
                    rows.push([`[${key}]`, '', '']);
                    const cols = Object.keys(items[0].value || {});
                    rows.push(['', ...cols, '']);
                    for (const item of items) {
                        if (item.value && typeof item.value === 'object') {
                            rows.push(['', ...cols.map(c => (item.value[c] ? item.value[c].value : '') || ''), '']);
                        }
                    }
                } else {
                    rows.push([key, items.map(i => i.value || '').join(' | '), conf]);
                }
            } else {
                rows.push([key, field.value !== null && field.value !== undefined ? field.value : '', conf]);
            }
        }
        return rows.map(r => r.map(csvCell).join(',')).join('\n');
    }

    _triggerDownload(content, mimeType, filename) {
        const blob   = new Blob([content], { type: mimeType });
        const url    = URL.createObjectURL(blob);
        const anchor = this.template.querySelector('[data-id="dl-anchor"]');
        anchor.href     = url;
        anchor.download = filename;
        anchor.click();
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    _safeFilename(title, ext) {
        return (title || 'extraction').replace(/[^a-z0-9_.-]/gi, '_') + '_results.' + ext;
    }

    // ── result array expand/collapse ─────────────────────────────────────

    get hasResults() { return this.resultFields.length > 0; }

    toggleArrayField(event) {
        const key = event.currentTarget.dataset.key;
        this.resultFields = this.resultFields.map(f => {
            if (f.key !== key) return f;
            const exp = !f.isExpanded;
            return { ...f, isExpanded: exp, expandIcon: exp ? 'utility:chevronup' : 'utility:chevrondown' };
        });
    }
}
