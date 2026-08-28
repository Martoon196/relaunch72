import {
  MIGRATION_CENTRE_CLIENT_ROUTE,
} from './migration-centre-service.js';

export const MIGRATION_CENTRE_CLIENT_ASSET_PATH = MIGRATION_CENTRE_CLIENT_ROUTE;

/**
 * Dependency-free same-origin enhancement. File names and bytes stay local
 * until the operator explicitly asks for a preview; file names are never sent.
 */
export const MIGRATION_CENTRE_CLIENT_SOURCE = String.raw`(() => {
  'use strict';

  const TARGETS = Object.freeze([
    ['contact.first_name', 'Contact · first name'],
    ['contact.last_name', 'Contact · last name'],
    ['contact.full_name', 'Contact · full name'],
    ['contact.email', 'Contact · email'],
    ['contact.phone', 'Contact · phone'],
    ['contact.company', 'Contact · company'],
    ['contact.job_title', 'Contact · job title'],
    ['lead.title', 'Lead · title'],
    ['lead.stage', 'Lead · stage'],
    ['lead.status', 'Lead · status'],
    ['lead.value', 'Lead · value'],
    ['lead.currency', 'Lead · currency'],
    ['lead.source', 'Lead · source'],
    ['lead.notes', 'Lead · notes']
  ]);
  const MAX_LOCAL_BYTES = 2 * 1024 * 1024;
  const MAX_HEADER_BYTES = 64 * 1024;

  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = String(value);
    return node;
  };

  const exactPortalUrl = (value) => {
    try {
      const url = new URL(String(value || ''), window.location.href);
      return url.origin === window.location.origin && url.pathname === '/portal/migrations/preview'
        ? url.toString()
        : null;
    } catch {
      return null;
    }
  };

  const base64urlUtf8 = (value) => {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  };

  const firstCsvRecord = (source) => {
    const value = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
    const cells = [];
    let cell = '';
    let quoted = false;
    let afterQuote = false;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (quoted) {
        if (character === '"') {
          if (value[index + 1] === '"') { cell += '"'; index += 1; }
          else { quoted = false; afterQuote = true; }
        } else {
          cell += character;
        }
        continue;
      }
      if (afterQuote) {
        if (character === ',') { cells.push(cell); cell = ''; afterQuote = false; continue; }
        if (character === '\r' || character === '\n') { cells.push(cell); return cells; }
        throw new Error('The CSV header has characters after a closing quote.');
      }
      if (character === '"') {
        if (cell.length) throw new Error('The CSV header quoting is invalid.');
        quoted = true;
      } else if (character === ',') {
        cells.push(cell); cell = '';
      } else if (character === '\r' || character === '\n') {
        cells.push(cell); return cells;
      } else {
        cell += character;
      }
    }
    if (quoted) throw new Error('The CSV header contains an unfinished quoted value.');
    if (afterQuote || cell.length || cells.length) cells.push(cell);
    return cells;
  };

  const appendDefinition = (parent, label, value) => {
    const item = document.createElement('div');
    item.className = 'mig-definition';
    item.append(text('dt', label));
    item.append(text('dd', value));
    parent.append(item);
  };

  const renderMappedValues = (parent, label, fields) => {
    if (!fields || typeof fields !== 'object') return;
    const section = document.createElement('div');
    section.className = 'mig-record-section';
    section.append(text('strong', label));
    const list = document.createElement('dl');
    Object.entries(fields).forEach(([field, evidence]) => {
      if (!evidence || typeof evidence.value !== 'string') return;
      appendDefinition(list, field.replace(/_/g, ' '), evidence.value + (evidence.truncated ? ' …' : ''));
    });
    section.append(list);
    parent.append(section);
  };

  const renderResult = (root, payload) => {
    const results = root.querySelector('[data-migration-results]');
    if (!results) return;
    results.replaceChildren();
    const heading = text('h2', 'Real preview receipt');
    results.append(heading);
    const summary = document.createElement('div');
    summary.className = 'mig-result-metrics';
    [
      ['Accepted', payload.summary.acceptedRowCount],
      ['Quarantined', payload.summary.quarantinedRowCount],
      ['Affiliate values', payload.summary.affiliateValueCount],
      ['Receipt', payload.disposition]
    ].forEach(([label, value]) => {
      const metric = document.createElement('div');
      metric.className = 'mig-result-metric';
      metric.append(text('span', label));
      metric.append(text('strong', value));
      summary.append(metric);
    });
    results.append(summary);

    const acceptedHeading = text('h3', 'Accepted row sample');
    results.append(acceptedHeading);
    const accepted = document.createElement('div');
    accepted.className = 'mig-record-grid';
    (Array.isArray(payload.acceptedRows) ? payload.acceptedRows : []).forEach((row) => {
      const card = document.createElement('article');
      card.className = 'mig-record-card';
      card.append(text('h4', 'Source row ' + row.sourceRowNumber));
      renderMappedValues(card, 'Contact', row.contact);
      renderMappedValues(card, 'Lead', row.lead);
      if (Array.isArray(row.affiliateSources) && row.affiliateSources.length) {
        const affiliate = document.createElement('div');
        affiliate.className = 'mig-record-section';
        affiliate.append(text('strong', 'Affiliate attribution'));
        const list = document.createElement('dl');
        row.affiliateSources.forEach((entry) => {
          appendDefinition(list, entry.column, entry.value + (entry.truncated ? ' …' : ''));
        });
        affiliate.append(list);
        card.append(affiliate);
      }
      accepted.append(card);
    });
    if (!accepted.childNodes.length) accepted.append(text('p', 'No rows passed the preview gates.'));
    results.append(accepted);
    if (payload.summary.omittedAcceptedRowCount) {
      results.append(text('p', payload.summary.omittedAcceptedRowCount + ' more accepted rows are bound into the receipt but omitted from this bounded browser sample.', 'mig-result-note'));
    }

    const quarantineHeading = text('h3', 'Quarantine evidence');
    results.append(quarantineHeading);
    const quarantine = document.createElement('ul');
    quarantine.className = 'mig-quarantine-list';
    (Array.isArray(payload.quarantinedRows) ? payload.quarantinedRows : []).forEach((row) => {
      const reasons = Array.isArray(row.reasons) ? row.reasons.join(', ').replace(/_/g, ' ') : 'unsafe row';
      const columns = Array.isArray(row.unsafeColumnIndexes) && row.unsafeColumnIndexes.length
        ? ' · unsafe columns ' + row.unsafeColumnIndexes.join(', ')
        : '';
      quarantine.append(text('li', 'Row ' + row.sourceRowNumber + ' · ' + reasons + columns));
    });
    if (!quarantine.childNodes.length) quarantine.append(text('li', 'No rows were quarantined.'));
    results.append(quarantine);

    const receipt = document.createElement('details');
    receipt.className = 'mig-receipt';
    receipt.append(text('summary', 'Tamper-evident receipt evidence'));
    const evidence = document.createElement('dl');
    appendDefinition(evidence, 'Batch', payload.receipt.batchId);
    appendDefinition(evidence, 'Source SHA-256', payload.receipt.sourceSha256);
    appendDefinition(evidence, 'Mapping SHA-256', payload.receipt.mappingSha256);
    appendDefinition(evidence, 'Affiliate SHA-256', payload.receipt.affiliateAttributionSha256);
    appendDefinition(evidence, 'Receipt SHA-256', payload.receipt.receiptSha256);
    appendDefinition(evidence, 'Expires', payload.receipt.expiresAt);
    receipt.append(evidence);
    results.append(receipt);
    results.hidden = false;
    results.focus();
  };

  const enhance = (root) => {
    const fileInput = root.querySelector('[data-migration-file]');
    const sourceInput = root.querySelector('[data-migration-source]');
    const mappingPanel = root.querySelector('[data-migration-mapping-panel]');
    const mappingBody = root.querySelector('[data-migration-mapping-body]');
    const previewButton = root.querySelector('[data-migration-preview]');
    const status = root.querySelector('[data-migration-status]');
    const endpoint = exactPortalUrl(root.dataset.previewUrl);
    const csrf = String(root.dataset.csrf || '');
    const idempotencyKeys = new Map();
    let fileReference = null;
    if (!fileInput || !sourceInput || !mappingPanel || !mappingBody || !previewButton || !status
        || !endpoint || csrf.length < 16) return;

    const announce = (message, error) => {
      status.textContent = message;
      status.dataset.kind = error ? 'error' : 'info';
    };

    const clearPreview = () => {
      const results = root.querySelector('[data-migration-results]');
      if (results) { results.hidden = true; results.replaceChildren(); }
    };

    const buildMappingRows = (headers) => {
      mappingBody.replaceChildren();
      const seen = new Set();
      headers.forEach((header, index) => {
        const label = String(header || '').trim();
        if (!label) throw new Error('Column ' + (index + 1) + ' has an empty header.');
        const folded = label.normalize('NFKC').toLocaleLowerCase('en-GB').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
        if (!folded || seen.has(folded)) throw new Error('CSV headers must be unique after normalisation.');
        seen.add(folded);
        const row = document.createElement('tr');
        row.dataset.sourceHeader = label;
        const headerCell = document.createElement('th');
        headerCell.scope = 'row';
        headerCell.textContent = label;
        row.append(headerCell);
        const targetCell = document.createElement('td');
        const select = document.createElement('select');
        select.setAttribute('aria-label', 'Map ' + label + ' to');
        select.dataset.mappingTarget = 'true';
        const ignored = document.createElement('option');
        ignored.value = '';
        ignored.textContent = 'Ignore column';
        select.append(ignored);
        TARGETS.forEach(([value, targetLabel]) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = targetLabel;
          select.append(option);
        });
        targetCell.append(select);
        row.append(targetCell);
        const affiliateCell = document.createElement('td');
        const affiliate = document.createElement('input');
        affiliate.type = 'checkbox';
        affiliate.dataset.affiliateSource = 'true';
        affiliate.setAttribute('aria-label', 'Preserve ' + label + ' as affiliate attribution');
        affiliateCell.append(affiliate);
        row.append(affiliateCell);
        const requiredCell = document.createElement('td');
        const required = document.createElement('input');
        required.type = 'checkbox';
        required.dataset.requiredTarget = 'true';
        required.disabled = true;
        required.setAttribute('aria-label', 'Require the mapped value from ' + label);
        select.addEventListener('change', () => {
          required.disabled = !select.value;
          if (!select.value) required.checked = false;
        });
        requiredCell.append(required);
        row.append(requiredCell);
        mappingBody.append(row);
      });
      mappingPanel.hidden = false;
    };

    fileInput.addEventListener('change', async () => {
      clearPreview();
      mappingPanel.hidden = true;
      mappingBody.replaceChildren();
      const file = fileInput.files && fileInput.files[0];
      if (!file) { announce('Choose a CSV file to begin.', false); return; }
      if (file.size < 1 || file.size > MAX_LOCAL_BYTES) {
        announce('Choose a non-empty CSV no larger than 2 MB.', true); return;
      }
      if (!/\.csv$/i.test(file.name)) {
        announce('Choose a file ending in .csv.', true); return;
      }
      try {
        const headerText = await file.slice(0, MAX_HEADER_BYTES).text();
        const headers = firstCsvRecord(headerText);
        if (!headers.length || headers.length > 100) throw new Error('The CSV must have between 1 and 100 columns.');
        buildMappingRows(headers);
        fileReference = window.crypto.randomUUID();
        announce('Headers loaded locally. Map at least one column, then request the secure preview.', false);
      } catch (error) {
        announce(error instanceof Error ? error.message : 'The CSV header could not be read safely.', true);
      }
    });

    previewButton.addEventListener('click', async () => {
      clearPreview();
      const file = fileInput.files && fileInput.files[0];
      if (!file || file.size < 1 || file.size > MAX_LOCAL_BYTES || !fileReference) {
        announce('Choose a valid CSV file first.', true); return;
      }
      const sourceSystem = sourceInput.value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(sourceSystem)) {
        announce('Use a short source name such as legacy-crm or old-ghl.', true); return;
      }
      const columns = [];
      const affiliateSourceHeaders = [];
      const requiredTargetFields = [];
      const targets = new Set();
      let duplicateTarget = false;
      Array.from(mappingBody.querySelectorAll('tr')).forEach((row) => {
        const sourceHeader = row.dataset.sourceHeader;
        const target = row.querySelector('[data-mapping-target]');
        const affiliate = row.querySelector('[data-affiliate-source]');
        const required = row.querySelector('[data-required-target]');
        if (target && target.value) {
          if (targets.has(target.value)) duplicateTarget = true;
          targets.add(target.value);
          columns.push({ sourceHeader: sourceHeader, targetField: target.value });
          if (required && required.checked) requiredTargetFields.push(target.value);
        }
        if (affiliate && affiliate.checked) affiliateSourceHeaders.push(sourceHeader);
      });
      if (duplicateTarget) { announce('Each Growth HQ destination can be mapped only once.', true); return; }
      if (!columns.length) { announce('Map at least one CSV column to a contact or lead field.', true); return; }
      const mapping = { columns: columns, affiliateSourceHeaders: affiliateSourceHeaders, requiredTargetFields: requiredTargetFields };
      const mappingHeader = base64urlUtf8(JSON.stringify(mapping));
      if (mappingHeader.length > 12000) { announce('That mapping is too large.', true); return; }
      const fingerprint = fileReference + ':' + sourceSystem + ':' + mappingHeader;
      let idempotencyKey = idempotencyKeys.get(fingerprint);
      if (!idempotencyKey) {
        idempotencyKey = window.crypto.randomUUID();
        idempotencyKeys.set(fingerprint, idempotencyKey);
      }
      const exportedAt = file.lastModified > 0 && file.lastModified <= Date.now() + 5 * 60 * 1000
        ? new Date(file.lastModified).toISOString()
        : null;
      previewButton.disabled = true;
      root.setAttribute('aria-busy', 'true');
      announce('Streaming this CSV into the effects-free preview boundary…', false);
      try {
        const headers = {
          'content-type': 'text/csv; charset=utf-8',
          'x-pp-migration-csrf': csrf,
          'idempotency-key': idempotencyKey,
          'x-pp-migration-source-system': sourceSystem,
          'x-pp-migration-source-reference': fileReference,
          'x-pp-migration-mapping': mappingHeader
        };
        if (exportedAt) headers['x-pp-migration-source-exported-at'] = exportedAt;
        const response = await window.fetch(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          headers: headers,
          body: file
        });
        const responseType = response.headers.get('content-type') || '';
        const payload = responseType.startsWith('application/json') ? await response.json() : null;
        if (!response.ok || !payload || payload.ok !== true) {
          const message = payload && payload.error && typeof payload.error.message === 'string'
            ? payload.error.message
            : 'The secure preview did not complete. Refresh and try again.';
          announce(message, true);
          return;
        }
        renderResult(root, payload);
        announce('Preview complete. Nothing was imported or written to customer records.', false);
      } catch {
        announce('The secure preview could not be reached. Nothing was imported.', true);
      } finally {
        previewButton.disabled = false;
        root.removeAttribute('aria-busy');
      }
    });
  };

  document.querySelectorAll('[data-migration-centre]').forEach(enhance);
})();`;
