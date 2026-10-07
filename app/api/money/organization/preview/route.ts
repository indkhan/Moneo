import {requireWorkspace} from '@/lib/auth';
import {loadOrganizationPreview,organizationPreviewSchema} from '@/lib/import-organization-preview';

export async function POST(request:Request) {
  let context:Awaited<ReturnType<typeof requireWorkspace>>;
  try {context=await requireWorkspace();}
  catch {return Response.json({error:'Unauthorized'},{status:401});}
  let input;
  try {
    const text=await request.text();
    if(new TextEncoder().encode(text).byteLength>10000)throw new Error('Preview input exceeds its limit');
    input=organizationPreviewSchema.parse(JSON.parse(text));
  } catch {return Response.json({error:'Choose up to 50 current transactions and an organization change'},{status:400});}
  try {return Response.json(await loadOrganizationPreview(context.supabase,context.workspace.id,input));}
  catch {return Response.json({error:'The selected history or organization targets changed; reload the preview'},{status:409});}
}
