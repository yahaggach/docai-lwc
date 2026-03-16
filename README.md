# Document AI — LWC Package
> Author: **Yassine Ahaggach**

A Lightning Web Component that exposes the **Salesforce Data Cloud Document Processing API** directly in any Salesforce org. Upload a PDF or image, define (or auto-generate) an extraction schema, pick an AI model, and get structured field-level results with confidence scores — all without leaving Salesforce.

---

## Prerequisites

Before deploying, confirm the following in the **target org**:

| Requirement | How to check |
|---|---|
| **Salesforce CLI installed** | Run `sf --version` in a terminal |
| **Data Cloud licensed and provisioned** | Setup → Data Cloud → must show an active Data Cloud instance |
| **API version 62.0+** | The component targets Spring '25 (v62.0). Older API versions are not supported |

---

## Step 1 — Find your org's My Domain URL

The Remote Site Setting must match the target org's domain exactly.

1. In Salesforce, go to **Setup → My Domain**
2. Copy the value shown under **Current My Domain URL** — it looks like:
   ```
   https://yourcompany.my.salesforce.com
   ```
   or for a sandbox:
   ```
   https://yourcompany--sandboxname.sandbox.my.salesforce.com
   ```

---

## Step 2 — Update the Remote Site Setting

Open the file:

```
force-app/main/default/remoteSiteSettings/DocAI_OrgDomain.remoteSite-meta.xml
```

Replace the placeholder URL with the one you copied in Step 1:

```xml
<!-- Before -->
<url>https://YOUR_ORG_DOMAIN.my.salesforce.com</url>

<!-- After (example) -->
<url>https://yourcompany.my.salesforce.com</url>
```

---

## Step 3 — Authenticate the Salesforce CLI to the target org

If you have not already connected the CLI to the target org, run one of the following:

**Production or Developer org:**
```bash
sf org login web --alias target-org
```

**Sandbox:**
```bash
sf org login web --alias target-org --instance-url https://test.salesforce.com
```

This opens a browser window. Log in with an admin account. Once authenticated, the alias `target-org` is available for subsequent commands.

---

## Step 4 — Deploy the package

From the root of this folder (where `sfdx-project.json` lives), run:

```bash
sf project deploy start --source-dir force-app --target-org target-org
```

This deploys all five metadata components at once:

| Component | Type | Purpose |
|---|---|---|
| `docAINative` | LightningComponentBundle | The UI component |
| `DocAINativeController` | ApexClass | Backend — calls the Document AI REST API |
| `DocAISessionHelper` | ApexPage | Session token bridge (required for REST auth) |
| `DocAI_OrgDomain` | RemoteSiteSetting | Allows the Apex callout back to the same org |

A successful deploy looks like:

```
Deployed Source
 State    Name                  Type
 Changed  docAINative           LightningComponentBundle
 Changed  DocAINativeController ApexClass
 Changed  DocAISessionHelper    ApexPage
 Changed  DocAI_OrgDomain       RemoteSiteSetting
```

---

## Step 5 — Add the component to a page

1. Open any Lightning App Builder page (App Page, Home Page, or Record Page)
2. Search for **"Native Document AI"** in the Components panel on the left
3. Drag it onto the canvas
4. Save and Activate the page

The component is also usable in **Experience Cloud** pages — add it through Experience Builder in the same way.

---

## How it works

```
User uploads / selects a PDF or image
       ↓
docAINative (LWC)
       ↓ calls Apex
DocAINativeController
       ↓ HTTP POST (same-org REST, session via DocAISessionHelper VF page)
/services/data/v65.0/ssot/document-processing/actions/extract-data
       ↓ Data Cloud Document Processing API
AI model (GPT-4o / Gemini 2.5 Flash / …)
       ↓ returns structured JSON + per-field confidence scores
Results rendered in the LWC — downloadable as JSON or CSV
```

### The session token bridge

Apex invoked from LWC receives a **restricted Lightning session token** that is not accepted by `/services/data/` REST endpoints. `DocAISessionHelper` is a minimal Visualforce page whose only purpose is to return `{!$Api.Session_ID}` — a full, unrestricted token — so the Apex controller can authenticate its callout. This is a well-known Salesforce pattern and requires no extra permissions.

---

## Files included

```
docai-lwc-package/
├── sfdx-project.json
├── README.md
└── force-app/main/default/
    ├── lwc/docAINative/
    │   ├── docAINative.html          UI template (3-step wizard)
    │   ├── docAINative.js            Controller (schema builder, extraction, download)
    │   ├── docAINative.css           Styles
    │   └── docAINative.js-meta.xml   Metadata (targets: App, Home, Record pages)
    ├── classes/
    │   ├── DocAINativeController.cls          Apex backend
    │   └── DocAINativeController.cls-meta.xml
    ├── pages/
    │   ├── DocAISessionHelper.page            VF session token bridge
    │   └── DocAISessionHelper.page-meta.xml
    └── remoteSiteSettings/
        └── DocAI_OrgDomain.remoteSite-meta.xml  ← update URL before deploying
```

---

## Troubleshooting

**"Document AI API error (404)"**
The Data Cloud Document Processing API endpoint is not reachable. Confirm that Data Cloud is licensed and provisioned in your org and that the API version in `sfdx-project.json` and `cls-meta.xml` matches or is lower than what your org supports.

**"Document AI API error (401)" or "403"**
The session token is invalid. Ensure `DocAISessionHelper.page` was deployed and that the running user has at least Read access to it. Also confirm the Remote Site Setting URL exactly matches the org's My Domain URL.

**The file picker is empty**
No PDF or image files are present in the org's Files (Content). Upload a file using the upload card in Step 1 of the component, or upload files through the standard Files tab first.

**Deploy error: "Invalid URL" on Remote Site Setting**
You have not updated the placeholder URL in `DocAI_OrgDomain.remoteSite-meta.xml`. See Step 2 above.
