// frontend/src/components/PdfThumbnails.tsx
"use client";

import React, { createContext, useContext, memo, useMemo } from "react";
import { Document, Page } from "react-pdf";

interface PdfThumbnailsProps {
  file: File;
  numPages: number;
  currentSlide: number;
  onSlideClick: (page: number) => void;
}

// ✅ 1. 상위 상태 변경을 몰래 전달하기 위한 비밀 통로(Context) 생성
const SlideContext = createContext<{ currentSlide: number; onSlideClick: (page: number) => void }>({
  currentSlide: 1,
  onSlideClick: () => {}
});

// ✅ 2. 알맹이(PDF 이미지) 철통 방어 컴포넌트
// 상위에서 무슨 일이 일어나든 절대 다시 그려지지 않으며, 높이 증발을 막아 스크롤을 지킵니다.
const StaticPage = memo(({ pageNumber }: { pageNumber: number }) => {
  return (
    <Page
      pageNumber={pageNumber}
      width={90}
      renderTextLayer={false}
      renderAnnotationLayer={false}
      // 초기 로딩 시 높이가 0이 되는 것을 막는 스켈레톤 박스
      loading={<div className="w-[90px] h-[67px] bg-gray-100 animate-pulse" />} 
    />
  );
});
StaticPage.displayName = "StaticPage";

// ✅ 3. 개별 썸네일 버튼 
// 전체 문서가 아닌, 오직 "자신"의 테두리 색상만 스무스하게 바꿉니다.
const ThumbnailItem = memo(({ pageNumber }: { pageNumber: number }) => {
  const { currentSlide, onSlideClick } = useContext(SlideContext);
  const isActive = currentSlide === pageNumber;

  return (
    <button
      onClick={() => onSlideClick(pageNumber)}
      className={`flex flex-col items-center gap-2 transition-all w-full px-2 mb-4 ${
        isActive ? "opacity-100 scale-105" : "opacity-60 hover:opacity-100"
      }`}
    >
      <div className={`w-full overflow-hidden flex items-center justify-center rounded-lg shadow-sm transition-all bg-white ${
        isActive ? "border-2 border-indigo-500 ring-4 ring-indigo-500/20" : "border border-gray-300 hover:border-gray-400"
      }`}>
        <StaticPage pageNumber={pageNumber} />
      </div>
      <span className={`text-[10px] font-bold ${isActive ? "text-indigo-600" : "text-gray-500"}`}>
        Slide {pageNumber}
      </span>
    </button>
  );
});
ThumbnailItem.displayName = "ThumbnailItem";

// ✅ 4. 전체 문서 컨테이너 박제
// memo로 감싸져 있어서, file과 numPages가 바뀌지 않는 한 절대 리렌더링되지 않습니다. (스크롤 초기화 원천 차단)
const DocumentWrapper = memo(({ file, numPages }: { file: File; numPages: number }) => {
  return (
    <Document
      file={file}
      className="flex flex-col items-center w-full"
      loading={<div className="p-4 text-xs text-center text-gray-400 animate-pulse">로딩 중...</div>}
    >
      {Array.from(new Array(numPages), (_, index) => (
        <ThumbnailItem key={`thumb-${index + 1}`} pageNumber={index + 1} />
      ))}
    </Document>
  );
});
DocumentWrapper.displayName = "DocumentWrapper";

// ✅ 5. 메인 컴포넌트: 비밀 통로(Context)에 데이터만 밀어 넣고 빠집니다.
export default function PdfThumbnails({ file, numPages, currentSlide, onSlideClick }: PdfThumbnailsProps) {

  const contextValue = useMemo(() => ({ currentSlide, onSlideClick }), [currentSlide, onSlideClick]);

  return (
    <SlideContext.Provider value={contextValue}>
      <DocumentWrapper file={file} numPages={numPages} />
    </SlideContext.Provider>
  );
}