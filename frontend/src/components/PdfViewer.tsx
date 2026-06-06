// frontend/src/components/PdfViewer.tsx
"use client";

import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// ⚠️ Next.js에서 PDF를 렌더링하기 위한 필수 워커(Worker) 설정
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PdfViewerProps {
  file: File | null;
  pageNumber: number;
  onLoadSuccess: (numPages: number) => void;
}

export default function PdfViewer({ file, pageNumber, onLoadSuccess }: PdfViewerProps) {
  // 파일이 없을 때 보여줄 기본 화면
  if (!file) {
    return (
      <div className="bg-white w-full h-full max-w-4xl rounded-xl shadow-lg flex items-center justify-center text-gray-400 border border-dashed border-gray-300">
        <p className="text-lg">상단의 [PDF 업로드] 버튼을 눌러 발표 자료를 추가해 주세요.</p>
      </div>
    );
  }

  // PDF 문서 로딩 성공 시 총 페이지 수를 부모 컴포넌트(page.tsx)로 전달
  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    onLoadSuccess(numPages);
  }

  return (
    <div className="flex justify-center items-center w-full h-full overflow-auto p-4 bg-gray-200">
      <Document
        file={file}
        onLoadSuccess={onDocumentLoadSuccess}
        loading={
          <div className="text-indigo-600 font-semibold animate-pulse flex items-center gap-2">
            <span>PDF 슬라이드 불러오는 중...</span>
          </div>
        }
        className="flex justify-center"
      >
        <Page 
          pageNumber={pageNumber} 
          renderTextLayer={false}        // 텍스트 드래그 기능 (UI 깔끔함을 위해 off)
          renderAnnotationLayer={false}  // 주석 레이어 (UI 깔끔함을 위해 off)
          className="shadow-2xl rounded-lg overflow-hidden"
          width={800} // 슬라이드 기본 가로 크기
        />
      </Document>
    </div>
  );
}