"use client";
import {useEffect,useState} from "react";
import Link from "next/link";
import BookEditor from "../../components/BookEditorClient";
export default function Page(){
 const [ready,setReady]=useState(false);
 useEffect(()=>{const chapters=[{id:"chapter",book_id:"book",title:"First chapter"},{id:"second",book_id:"book",title:"Second chapter"}]; const nodes=[{id:"p",type:"paragraph",text:"Original manuscript"}]; (window as any).__historyApi={getBook:async()=>({book:{id:"book",workspace_id:"workspace",title:"Test book"},role:"owner"}), listChapters:async()=>({chapters}),getChapterTitle:async()=>({bookId:"book",chapterId:"chapter",title:"First chapter",revision:0,updatedAt:"2026-10-23T15:00:00Z",role:"owner"}),getChapterDocument:async()=>({role:"owner",document:{chapterId:"chapter",version:1,nodes}}),listDocumentVersions:async()=>({versions:[{id:"v1",version_number:1,created_at:"2026-10-05T12:00:00Z",plain_text:"Original manuscript"}]}), restoreDocumentVersion:async()=>{(window as any).restoreCalled=true;return await new Promise(()=>{})}, reorderChapters:async()=>{(window as any).reorderCalled=true;return await new Promise(()=>{})},listAiJobs:async()=>({jobs:[]})};setReady(true);},[]);
 return <main><a href="#history-hash">Same page hash</a><div id="history-hash">Hash target</div><Link href="/history-after">Go after</Link>{ready && <BookEditor bookId="book"/>}</main>;
}
