'use strict';

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '【LINEチャネルアクセストークン(長期)】',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '【LINEチャネルシークレット】',
};

const CONFIG_FILE_BASE = './data/line-todoist/';
const MAX_QUICKREPLY = 13;

const TODOIST_CLIENT_ID = process.env.TODOIST_CLIENT_ID || "【todoistのClient ID】";
const TODOIST_CLIENT_SECRET = process.env.TODOIST_CLIENT_SECRET || "【todoistのClient secret】";

const ADMIN_PAGE_URL = process.env.ADMIN_PAGE_URL || "https://【サーバのホスト名】/admin/index.html";

const HELPER_BASE = process.env.HELPER_BASE || '../../helpers/';
const Response = require(HELPER_BASE + 'response');

const Todoist = require('todoist').v8;
const crypto = require('crypto');

const line = require('@line/bot-sdk');
const LineUtils = require(HELPER_BASE + 'line-utils');
const app = new LineUtils(line, config);

const { URL, URLSearchParams } = require('url');
const fetch = require('node-fetch');
const Headers = fetch.Headers;
const fs = require('fs').promises;

// スラッシュコマンド解析
function parse_command(text){
  var text = text.trim();
  if( !text.startsWith('/') )
    return null;
  
  var args = text.split(' ', 3);

  if( args[0] == '/'){
    return { cmd: 'default' };
  }else
  if( args[0] == '/todoist' ){
    switch(args[1]){
      case 'config': return { cmd: 'todoist', ope: 'config' };
      default: throw 'invalid command';
    }
  }else
  if( args[0] == '/todo' ){
    switch(args[1]){
      case 'add': return { cmd: 'todo', ope: 'add', param: args[2] };
      default: throw 'invalid command';
    }
  }else{
    throw 'invalid command';
  }
}

// sourceId取得
function parse_sourceId(source){
  if( source.type == 'group' )
    return source.type + '-' + source.groupId;
  else if( source.type == 'user')
    return source.type + '-' + source.userId;
  else
    return null;
}

// 日時文字列の変換
function date_parse(str, disp){
  if( !disp )
    return "　";
  var date = new Date(str);
  if( disp == 'date'){
    return date.toLocaleDateString();
  }else if( disp == 'time'){
    if( str.indexOf('T') >= 0 )
      return date.toLocaleTimeString();
    else
      return "　";
  }else{
    if( str.indexOf('T') >= 0 )
      return date.toLocaleString();
    else
      return date.toLocaleDateString();
  }
}

// LINEメッセージの処理
app.message(async (event, client) =>{
  console.log(event);
  var text = event.message.text.trim();
  var command = parse_command(text);

  // スラッシュコマンドかどうか
  if( !command )
    return;

  // sourceIdの取得
  var sourceId = parse_sourceId(event.source);

  if( command.cmd == 'default' ){
    return client.replyMessage(event.replyToken, make_tasksearch_suggestion());
  }else
  if( command.cmd == 'todoist' && command.ope == 'config'){
    // sourceIdからConfigファイルの取得
    var conf = await readConfigFile(sourceId);
    if( !conf )
      conf = {}; // 新規登録

    var message;
    if( !conf.token ){
      // 新規登録
      conf.state = sourceId + '_' + Buffer.from(crypto.randomBytes(12)).toString('hex');
      await writeConfigFile(sourceId, conf);
      message = {
        type: "template",
        altText: "設定",
        template: {
          type: "buttons",
          text: "まだTodoistが設定されていません。",
          actions: [
            {
              type: "uri",
              label: "設定ページ",
              uri: "https://todoist.com/oauth/authorize?client_id=" + TODOIST_CLIENT_ID + "&scope=data:read_write&state=" + conf.state + "&openExternalBrowser=1"
            }
          ]
        }
      }
    }else{
      // 登録済み
      message = {
        type: "template",
        altText: "設定",
        template: {
          type: "buttons",
          text: "すでにTodoistが設定されています。",
          actions: [
            {
              type: "uri",
              label: "設定ページ",
              uri: ADMIN_PAGE_URL + "?openExternalBrowser=1"
            }
          ]
        }
      }
    }
    return client.replyMessage(event.replyToken, message);
  }else
  if( command.cmd == 'todo' && command.ope == 'add' ){
    // タスクの追加

    // sourceIdからConfigファイル取得
    var conf = await readConfigFile(sourceId);
    if( !conf || !conf.token )
      return client.replyMessage(event.replyToken, { type: 'text', text: 'todoistが設定されていません。' });

    // 指定プロジェクトにタスクの追加
    const todoist = Todoist(conf.token.access_token);
    const newItem = await todoist.items.add({ content: command.param, project_id: conf.project_id });

    var item_id = newItem.id;
    return client.replyMessage(event.replyToken, make_item_suggestion(item_id, "やることリストに追加しました。"));
  }else{
//    const echo = { type: 'text', text: text + 'だよ' };
//    return client.replyMessage(event.replyToken, echo);
  }
});

// postback処理
app.postback(async (event, client) =>{
  console.log(event);

  // sourceIdからConfigファイル取得
  var sourceId = parse_sourceId(event.source);
  var conf = await readConfigFile(sourceId);
  if( !conf || !conf.token )
    return client.replyMessage(event.replyToken, { type: 'text', text: 'todoistが設定されていません。' });

  // dataパラメータの解析
  var data = event.postback.data.split(',');

  if( data[0] == 'default' ){
    return client.replyMessage(event.replyToken, make_tasksearch_suggestion());
  }else
  if( data[0] == 'todo_asign_select'){
    // アサイン選択要求(todo_asign_select,item_id)
    var item_id = parseInt(data[1]);

    // todoist.sync()呼び出し
    const todoist = Todoist(conf.token.access_token);

    // タスクの検索
    await todoist.sync();
    var task = todoist.items.get().find(item => item.id == item_id);

    const collaborators = todoist.sharing.collaborators();
    const collaboratorStates = todoist.state.collaborator_states;
    // 指定プロジェクトの共有ユーザリストの抽出
    var members = collaboratorStates.filter(item => item.project_id == conf.project_id );

    if( members.length > 0){
      var message = {
        type: 'text',
        text: "アサインする人を選択してください。",
        quickReply: {
          items: []
        }
      };
      members.forEach(member =>{
        const user = collaborators.find(item => member.user_id == item.id);
        const param = {
          type: "action",
          action: {
            type: "postback",
            label: user.full_name,
            data: "todo_asign," + item_id + ',' + user.id,
            displayText: user.full_name
          }
        }
        message.quickReply.items.push(param);
      });

      return client.replyMessage(event.replyToken, message);
    }else{
      return client.replyMessage(event.replyToken, make_item_suggestion(item_id, "アサインできる人がいません。", (task.due) ? task.due.date : undefined));
    }
  }else
  if(data[0] == 'todo_asign'){
    // アサイン要求(todo_asign,item_id,user_id)
    var item_id = parseInt(data[1]);
    var user_id = parseInt(data[2]);
    const todoist = Todoist(conf.token.access_token);
    todoist.items.update({ id: item_id, responsible_uid: user_id});

    // タスクの検索
    await todoist.sync();
    var task = todoist.items.get().find(item => item.id == item_id );

    return client.replyMessage(event.replyToken, make_item_suggestion(item_id, "変更しました。", (task.due) ? task.due.date : undefined ));
  }else
  if(data[0] == 'todo_duedate'){
    // 期限(日付)設定要求(todo_duedate,item_id)
    var item_id = parseInt(data[1]);
    const todoist = Todoist(conf.token.access_token);
    todoist.items.update({ id: item_id, due: { date: event.postback.params.date, lang: 'ja' }});

    return client.replyMessage(event.replyToken, make_item_suggestion(item_id, "変更しました。", event.postback.params.date));
  }else
  if( data[0] == 'todo_today' || data[0] == 'todo_tommorow' || data[0] == 'todo_other' || data[0] == 'todo_someday' || data[0] == 'todo_expire'){
    // タスクリスト取得要求(todo_xxx)

    // todoist.sync()呼び出し
    const todoist = Todoist(conf.token.access_token);
    await todoist.sync();
    const collaborators = todoist.sharing.collaborators();
    var items = todoist.items.get();
    if( conf.project_id )
      items = items.filter(item => item.project_id == conf.project_id); // 対象プロジェクトにフィルタリング

    // 境界時間の算出
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var todayTime = today.getTime(); // 今日の開始
    var tomorrow = new Date();
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    var tomorrowTime = tomorrow.getTime();
    var aftertomorrow = new Date(); // 明日の開始
    aftertomorrow.setHours(0, 0, 0, 0);
    aftertomorrow.setDate(aftertomorrow.getDate() + 2);
    var aftertomorrowTime = aftertomorrow.getTime(); // 明後日の開始

    var target_list;
    var title;
    if( data[0] == 'todo_today' ){
      // 期限が今日の始めから明日の始め
      title = "今日";
      target_list = items.filter( item => item.due && Date.parse(item.due.date) >= todayTime && Date.parse(item.due.date) < tomorrowTime );
    }else
    if( data[0] == 'todo_tommorow' ){
      // 期限が明日の初めから明後日の始め
      title = "明日";
      target_list = items.filter( item => item.due && Date.parse(item.due.date) >= tomorrowTime && Date.parse(item.due.date) < aftertomorrowTime );
    }else
    if( data[0] == 'todo_other' ){
      // 期限が明後日の始め以降
      title = "明後日以降";
      target_list = items.filter( item => item.due && Date.parse(item.due.date) >= aftertomorrowTime );
    }else
    if( data[0] == 'todo_expire' ){
      // 期限が今日の始め以前
      title = "期限切れ";
      target_list = items.filter( item => item.due && Date.parse(item.due.date) < todayTime );
    }else{
      // 期限が未設定
      title = 'いつか';
      target_list = items.filter( item => !item.due );
    }
    console.log(target_list);

    var message = make_todolist_message(title + "のやることリスト", target_list, collaborators);
    return client.replyMessage(event.replyToken, message);
  }else
  if( data[0] == 'todo_detail'){
    // タスクの詳細表示要求(todo_detail,item_id)
    var item_id = parseInt(data[1]);

    // todoist.sync()呼び出し
    const todoist = Todoist(conf.token.access_token);
    await todoist.sync();
    var items = todoist.items.get();
    const collaborators = todoist.sharing.collaborators();
    var notes = todoist.notes.get();
    var labels = todoist.labels.get();

    // タスクの検索
    var task = items.find(item => item.id == item_id );
    console.log(task);

    var message = make_tododetail_message(task, collaborators, notes, labels);
    return client.replyMessage(event.replyToken, message);
  }else
  if( data[0] == 'todo_complete'){
    // タスク完了要求(todo_complete,item_id)
    var item_id = parseInt(data[1]);
    const todoist = Todoist(conf.token.access_token);
    todoist.items.complete({ id: item_id} );

    return client.replyMessage(event.replyToken, { type: 'text', text: "完了にしました" });
  }
});

exports.fulfillment = app.lambda();

exports.handler = async (event, context, callback) => {
  var body = JSON.parse(event.body);

	if( event.path == '/line-todoist-callback' ){
    // トークン取得処理
    var apikey = event.requestContext.apikeyAuth.apikey;
    var params = body.state.split('_', 2)
    var sourceId = params[0];

    var conf = await readConfigFile(sourceId);
    if( !conf )
      throw "invalid state";
    if( conf.state != body.state )
      throw "invalid state";

    // トークン取得呼び出し
    var param = {
			client_id: TODOIST_CLIENT_ID,
			client_secret: TODOIST_CLIENT_SECRET,
			code: body.code
		};
		var json = await do_post("https://todoist.com/oauth/access_token", param );

    // sourceIdのConfigファイル更新
    if( !conf.apikey ){
      conf.apikey = apikey;
    }else
    if( conf.apikey != apikey ){
        throw 'invalid apikey';
    }

    conf.token = json;
		await writeConfigFile(sourceId, conf);

		return new Response({ sourceId: sourceId });
  }else
  if( event.path == '/line-todoist-get-config' ){
    // Configファイル取得要求
    var apikey = event.requestContext.apikeyAuth.apikey;
    var sourceId = body.sourceId;

    var conf = await readConfigFile(sourceId);
    if( conf.apikey != apikey )
      throw 'apikey mismatch';

    // todoist.sync()呼び出し
    const todoist = Todoist(conf.token.access_token);
    await todoist.sync();
    // プロジェクトリスト取得
    const projects = todoist.projects.get();
    
    const setting = {
      sourceId: sourceId,
      project_id: conf.project_id,
    };
    return new Response({ projects: projects, config: setting });
  }else
  if( event.path == '/line-todoist-set-config' ){
    // project_id設定要求
    var apikey = event.requestContext.apikeyAuth.apikey;
    var sourceId = body.sourceId;

    // sourceIdのConfigファイル更新
    var conf = await readConfigFile(sourceId);
    if( conf.apikey != apikey )
      throw 'apikey mismatch';

    conf.project_id = body.project_id;
		await writeConfigFile(sourceId, conf);

    return new Response({});
  }
};

// アルファベットとハイフン以外が含まれていないか
function checkAlnumHyphen(str){
	var ret =  str.match(/([a-z]|[A-Z]|[0-9]|-)/gi);
	return (ret.length == str.length )
}

// Configファイル読み出し
async function readConfigFile(sourceId){
  if( !checkAlnumHyphen(sourceId) )
    throw "sourceId invalid";

  try{
    var conf = await fs.readFile(CONFIG_FILE_BASE + sourceId + '.json', 'utf8');
    if( !conf ){
      conf = {};
      await writeConfigFile(sourceId, conf);
    }else{
      conf = JSON.parse(conf);
    }
    return conf;
  }catch(error){
    return null;
  }
}

// Configファイル書き込み
async function writeConfigFile(sourceId, conf){
  if( !checkAlnumHyphen(sourceId) )
    throw "sourceId invalid";
    
	await fs.writeFile(CONFIG_FILE_BASE + sourceId + '.json', JSON.stringify(conf, null, 2), 'utf8');
}

// HTTP Post呼び出し
function do_post(url, body) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });

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

// タスク詳細表示メッセージの生成
function make_tododetail_message(todo, collaborators, notes, labels) {
  var message = {
    type: "flex",
    altText: todo.content,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: todo.content,
            size: "md"
          },
          {
            type: "box",
            layout: "baseline",
            spacing: "sm",
            contents: [
              {
                type: "text",
                text: "期限",
                size: "sm",
                flex: 1
              },
              {
                type: "text",
                text: todo.due ? date_parse(todo.due.date, "datetime") : "　",
                size: "sm",
                flex: 4
              }
            ]
          },
          {
            type: "box",
            layout: "baseline",
            spacing: "sm",
            contents: [
              {
                type: "text",
                text: "担当",
                size: "sm",
                flex: 1
              },
              {
                type: "text",
                text: todo.responsible_uid ? collaborators.find(item => item.id == todo.responsible_uid).full_name : "　",
                size: "sm",
                flex: 4
              }
            ]
          }
        ]
      }
    },
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "完了にする",
            data: 'todo_complete,' + todo.id,
            displayText: "完了にする"
          }
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "戻る",
            data: 'default',
            displayText: "戻る"
          }
        },
      ]
    }
  };

  var note = notes.filter( item => item.item_id == todo.id );
  if( note.length > 0 ){
    var elem = {
      type: "box",
      layout: "vertical",
      margin: "xs",
      paddingAll: "md",
      contents: []
    };
    note.forEach(item =>{
      var param = {
        type: "box",
        layout: "horizontal",
        contents: [
          {
            type: "text",
            text: item.content,
            size: "xs"
          },
          {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "text",
                text: collaborators.find(who => who.id == item.posted_uid).full_name,
                size: "xxs"
              },
              {
                type: "text",
                text: date_parse(item.posted, "datetime"),
                size: "xxs"
              }
            ]
          }
        ]
      };

      elem.contents.push(param);
    });
    message.contents.body.contents.push(elem);
  }

  if(todo.labels && todo.labels.length > 0 ){
    var label_str = "";
    for( var i = 0 ; i < todo.labels.length ; i++ ){
      var label = labels.find(item => item.id == todo.labels[i]);
      label_str += label.name + " ";
    }

    var elem = {
      type: "box",
      layout: "baseline",
      spacing: "sm",
      contents: [
        {
          type: "text",
          text: "ラベル",
          size: "sm",
          flex: 1
        },
        {
          type: "text",
          text: label_str,
          size: "sm",
          flex: 4
        }
      ]
    }
    message.contents.body.contents.push(elem);
  }

  return message;
}

// タスクリスト表示メッセージの生成
function make_todolist_message(title, list, collaborators, disp_due) {
  console.log(title);
  console.log(list);
  console.log(collaborators);

  var message = {
    type: "flex",
    altText: title,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: title,
            size: "md"
          }
        ]
      }
    },
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "戻る",
            data: 'default',
            displayText: "戻る"
          }
        },
      ]
    }
  };

  if( list.length == 0 ){
    var elem = {
      type: "box",
      layout: "baseline",
      spacing: "sm",
      contents: [
        {
          type: "text",
          text: "1件もありません。",
          size: "sm",
          flex: 1
        }
      ]
    };
    message.contents.body.contents.push(elem);
  }else{
    for(var i = 0 ; i < list.length ; i++ ){
      var elem = {
        type: "box",
        layout: "baseline",
        spacing: "sm",
        contents: [
          {
            type: "text",
            text: String(i + 1),
            size: "sm",
            flex: 1
          },
          {
            type: "text",
            text: list[i].content,
            size: "sm",
            flex: 4
          }
        ]
      };
      var param = {
        type: "text",
        text: list[i].responsible_uid ? collaborators.find(item => item.id == list[i].responsible_uid).full_name : "　",
        size: "sm",
        flex: 2
      };
      elem.contents.push(param);

      var param = {
        type: "text",
        text: ( disp_due && list[i].due ) ? date_parse(lite[i].due.date, disp_due) : "　",
        size: "sm",
        flex: 2
      };
      elem.contents.push(param);

      message.contents.body.contents.push(elem);

      if( i < MAX_QUICKREPLY - 1 ){
        var qr = {
          type: "action",
          action: {
            type: "postback",
            label: String(i + 1),
            data: 'todo_detail,' + list[i].id,
            displayText: String(i + 1)
          }
        };

        message.quickReply.items.push(qr);
      }
    }
  }

  return message;
}

// タスク検索のサジェスチョン表示メッセージの生成
function make_tasksearch_suggestion(){
  var message = {
    type: 'text',
    text: 'やることリストを選択してください。',
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "今日",
            data: 'todo_today',
            displayText: "今日"
          }
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "明日",
            data: 'todo_tommorow',
            displayText: "明日"
          }
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "明後日以降",
            data: 'todo_other',
            displayText: "明後日以降"
          }
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "いつか",
            data: 'todo_someday',
            displayText: "いつか"
          }
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "期限切れ",
            data: 'todo_expire',
            displayText: "期限切れ"
          }
        }
      ]
    }
  };
  
  return message;
}

// 生成したタスクのサジェスチョンメッセージの生成
function make_item_suggestion(item_id, text, date){
  var message = {
    type: 'text',
    text: text,
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "アサイン設定",
            data: 'todo_asign_select,' + item_id,
            displayText: "アサイン設定"
          }
        },
        {
          type: "action",
          action: {
            type:"datetimepicker",
            label:"期限(日付)",
            data: 'todo_duedate,' + item_id,
            mode:"date",
          }
        }
      ]
    }
  };

  if( date ){
    // 日時の初期値設定
    message.quickReply.items[1].action.initial = date;
  }
  
  return message;
}
