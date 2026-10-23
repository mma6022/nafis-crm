import fs from "node:fs";
import { queryRow,queryRows } from "./crm-db";
const types=["national_card_front","national_card_back","birth_cert_p1","birth_cert_p2","birth_cert_p3"];
export function portalDocumentsState(customerId:number,feeCreatedAt:string|null) {
  const customer=queryRow<{identity_changed_at:string|null}>("SELECT identity_changed_at FROM customers WHERE id=?",[customerId]);
  const changed=customer?.identity_changed_at??null;
  const rows=queryRows<any>(`SELECT * FROM customer_identity_documents WHERE customer_id=? AND is_latest=1
    AND (? IS NULL OR created_at>?)`,[customerId,changed,changed]);
  const present=(type:string,approved:boolean)=>rows.some(d=>d.document_type===type&&d.storage_path&&fs.existsSync(d.storage_path)&&
    !d.review_reason&&(approved?!!d.approved_at:!!feeCreatedAt&&d.created_at>=feeCreatedAt));
  const documentsPreviouslyApproved=types.every(type=>present(type,true));
  const aliases:Record<string,string>={birth_cert_p1:"birth_certificate_first_page",birth_cert_p2:"birth_certificate_second_page",birth_cert_p3:"birth_certificate_last_page"};
  const requiredDocumentTypes=documentsPreviouslyApproved?[]:types.filter(type=>!present(type,false)).map(type=>aliases[type]??type);
  return {documentsPreviouslyApproved,documentsComplete:requiredDocumentTypes.length===0,requiredDocumentTypes};
}
