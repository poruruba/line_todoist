'use strict';

//var vConsole = new VConsole();

const base_url = "https://【サーバのURL】";
const TODOIST_CLIENT_ID = "【todoistのClient ID】";
const EXPIRES = 3650;

var vue_options = {
    el: "#top",
    data: {
        progress_title: '', // for progress-dialog

        project_id: null,
        project_list: [],
        sourceId: null,
        apikey: null,
        input_sourceId: null,
        input_apikey: null,
    },
    computed: {
    },
    methods: {
        set_config: function(){
            // 手動設定
            this.apikey = this.input_apikey;
            this.sourceId = this.input_sourceId;
            Cookies.set("line_apikey", this.apikey, { expires: EXPIRES });
            Cookies.set("line_sourceId", this.sourceId, { expires: EXPIRES });

            this.get_config();

            this.dialog_close('#config_dialog');
        },
        set_project_id: async function(){
            // 対象プロジェクトの設定
            try{
                var param = {
                    sourceId: this.sourceId,
                    project_id: this.project_id,
                };
                this.progress_open();
                await do_post_apikey(base_url + '/line-todoist-set-config', param, this.apikey);

                Cookies.set("line_project_id", this.project_id, { expires: EXPIRES });
                this.get_config();
            }catch(error){
                console.error(error);
                alert(error);
            }finally{
                this.progress_close();
            }
        },
        get_config: async function(){
            // 現在設定情報の取得
            if( !this.apikey || !this.sourceId )
                return;

            try{
                var json = await do_post_apikey(base_url + '/line-todoist-get-config', { sourceId: this.sourceId }, this.apikey);

                this.project_list = json.projects;
                this.project_id = json.config.project_id;
            }catch(error){
                console.error(error);
                alert(error);
            }
        },
    },
    created: function(){
    },
    mounted: function(){
        proc_load();

        if( searchs.code ){
            // todoist認証後の認可コード
            var state = searchs.state;
            var code = searchs.code;
            history.replaceState(null, null, '.');
            var apikey = prompt("API Keyを指定してください。");
            if( !apikey )
                return;

            // todoistのトークン設定
            var param = {
                code: code,
                state: state
            };
            do_post_apikey(base_url + '/line-todoist-callback', param, apikey)
            .then(json =>{
                this.apikey = apikey;
                this.sourceId = json.sourceId;
                Cookies.set("line_apikey", this.apikey, { expires: EXPIRES });
                Cookies.set("line_sourceId", this.sourceId, { expires: EXPIRES });

                this.get_config();
            });
        }else{
            // 通常起動
            this.apikey = Cookies.get('line_apikey');
            this.sourceId = Cookies.get('line_sourceId');
            this.project_id = Cookies.get('line_project_id');
            if( this.apikey && this.sourceId ){
                // 現在設定情報の取得
                this.get_config();
            }else{
                setTimeout( () =>{
                    alert('API Keyを指定してください。');
                }, 0);
            }
        }
    }
};
vue_add_methods(vue_options, methods_bootstrap);
vue_add_components(vue_options, components_bootstrap);
var vue = new Vue( vue_options );

function do_post_apikey(url, body, apikey) {
    const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "X-API-KEY": apikey });

    return fetch(new URL(url).toString(), {
        method: 'POST',
        body: JSON.stringify(body),
        headers: headers
        })
        .then((response) => {
        if (!response.ok)
            throw 'status is not 200';
        return response.json();
    });
}
