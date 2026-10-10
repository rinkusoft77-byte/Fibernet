import v25 from './index-v25.js';
import {handleAdminWeb} from './v26-admin-web.js';

const VERSION='26.0.0';

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(url.pathname==='/admin'||url.pathname.startsWith('/admin/')){
      try{return await handleAdminWeb(request,env);}
      catch(e){
        console.error('v26 admin web error',e?.name||'Error');
        return Response.json({error:'Server error'},{
          status:500,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}
        });
      }
    }
    if(request.method==='GET'&&url.pathname==='/')
      return new Response('FiberNet Assistant v'+VERSION+' is running.',{
        headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}
      });
    if(request.method==='GET'&&url.pathname==='/health'&&!url.searchParams.has('details')){
      const res=await v25.fetch(request,env,ctx);
      try{
        const data=await res.json();
        return Response.json({...data,version:VERSION},{
          status:res.status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}
        });
      }catch{return res;}
    }
    return v25.fetch(request,env,ctx);
  },
  async scheduled(controller,env,ctx){
    return v25.scheduled(controller,env,ctx);
  }
};

export const __test={version:VERSION};
