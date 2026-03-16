/**
 * @author Yassine Ahaggach
 * @description Apex controller for the Document AI LWC component.
 */
public with sharing class DocAINativeController {

    private static final String API_BASE  = '/services/data/v65.0/ssot/document-processing';
    private static final Integer TIMEOUT  = 120000;

    // ── File helpers ──────────────────────────────────────────────────────

    // Returns the 20 most recently uploaded PDF/image files accessible to the
    // current user. Users can also upload directly from the LWC file picker.
    @AuraEnabled(cacheable=true)
    public static List<Map<String,String>> getAvailableFiles() {
        List<Map<String,String>> result = new List<Map<String,String>>();
        for (ContentVersion cv : [
            SELECT Id, Title, ContentDocumentId, FileType, ContentSize
            FROM   ContentVersion
            WHERE  FileType IN ('PDF', 'PNG', 'JPG', 'JPEG', 'EXCEL', 'POWER_POINT')
            AND    IsLatest = true
            ORDER  BY CreatedDate DESC
            LIMIT  200
        ]) {
            Map<String,String> f = new Map<String,String>();
            f.put('versionId',    cv.Id);
            f.put('documentId',   cv.ContentDocumentId);
            f.put('title',        cv.Title);
            f.put('fileType',     cv.FileType);
            f.put('size',         String.valueOf(cv.ContentSize));
            result.add(f);
        }
        return result;
    }

    // ── Global config (models + supported types) ──────────────────────────

    @AuraEnabled(cacheable=true)
    public static String getGlobalConfig() {
        HttpResponse res = doGet(API_BASE + '/global-config');
        checkResponse(res);
        return res.getBody();
    }

    // ── Schema generation ─────────────────────────────────────────────────

    @AuraEnabled
    public static String generateSchema(String fileVersionId, String mlModel) {
        String body = JSON.serialize(new Map<String, Object>{
            'mlModel' => mlModel,
            'files'   => new List<Object>{
                new Map<String,String>{ 'fileId' => fileVersionId }
            }
        });
        HttpResponse res = doPost(API_BASE + '/actions/generate-schema', body);
        checkResponse(res);
        return res.getBody();
    }

    // ── Data extraction ───────────────────────────────────────────────────

    @AuraEnabled
    public static String extractData(String fileVersionId, String mlModel, String schemaConfig) {
        // schemaConfig is already a JSON string — serialize it so it becomes
        // a properly quoted/escaped JSON string value inside the request body.
        String body = '{'
            + '"mlModel":'     + JSON.serialize(mlModel)     + ','
            + '"files":[{"fileId":' + JSON.serialize(fileVersionId) + '}],'
            + '"schemaConfig":' + JSON.serialize(schemaConfig)
            + '}';
        String path = API_BASE + '/actions/extract-data?extractDataWithConfidenceScore=true';
        HttpResponse res = doPost(path, body);
        checkResponse(res);

        // The raw API response may contain unescaped double-quotes inside string
        // values. Parsing with deserializeUntyped + re-serializing with JSON.serialize
        // normalises all escaping before Salesforce transports the data to the LWC.
        try {
            Object parsed = JSON.deserializeUntyped(res.getBody());
            return JSON.serialize(parsed);
        } catch (Exception e) {
            return JSON.serialize(new Map<String,Object>{
                'parseError' => e.getMessage(),
                'rawBody'    => res.getBody().left(2000)
            });
        }
    }

    // ── Private HTTP helpers ──────────────────────────────────────────────

    private static HttpResponse doGet(String path) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(URL.getOrgDomainUrl().toExternalForm() + path);
        req.setMethod('GET');
        req.setHeader('Authorization', 'Bearer ' + getRestSessionId());
        req.setHeader('Content-Type',  'application/json');
        req.setTimeout(TIMEOUT);
        return new Http().send(req);
    }

    private static HttpResponse doPost(String path, String body) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(URL.getOrgDomainUrl().toExternalForm() + path);
        req.setMethod('POST');
        req.setHeader('Authorization', 'Bearer ' + getRestSessionId());
        req.setHeader('Content-Type',  'application/json');
        req.setBody(body);
        req.setTimeout(TIMEOUT);
        return new Http().send(req);
    }

    /**
     * UserInfo.getSessionId() returns a restricted Lightning/Aura session token
     * that is NOT valid for same-org REST API calls when Apex is invoked from LWC.
     * Reading {!$Api.Session_ID} from a Visualforce page via PageReference.getContent()
     * returns a full, unrestricted session ID that works with /services/data/.
     */
    private static String getRestSessionId() {
        return Page.DocAISessionHelper.getContent().toString().trim();
    }

    private static void checkResponse(HttpResponse res) {
        if (res.getStatusCode() >= 400) {
            throw new AuraHandledException(
                'Document AI API error (' + res.getStatusCode() + '): ' + res.getBody()
            );
        }
    }
}
