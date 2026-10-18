import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Stage, Layer, Rect, Text, Image as KonvaImage, Line, Group, Transformer, Circle } from 'react-konva';
import useImage from 'use-image';
import { v4 as uuidv4 } from 'uuid';
import { NoteElement, ProjectNote, Point, ScaleConfig } from '../types';
import { Type, Image as ImageIcon, Type as TextIcon, Link as LinkIcon, Table as TableIcon, Pencil, MousePointer2, ZoomIn, ZoomOut, Maximize, Trash2, Ruler, Square, Hand, Grid } from 'lucide-react';
import { calculatePolylineLength, formatMeasurement } from '../utils/math';

interface NotesBoardProps {
  projectId: string;
  initialNote: ProjectNote | null;
  onSave: (note: ProjectNote) => void;
}

const ELEMENT_TYPES = [
  { id: 'select', icon: MousePointer2, label: 'Select' },
  { id: 'pan', icon: Hand, label: 'Pan' },
  { id: 'text', icon: TextIcon, label: 'Text' },
  { id: 'image', icon: ImageIcon, label: 'Image' },
  { id: 'table', icon: TableIcon, label: 'Table' },
  { id: 'drawing', icon: Pencil, label: 'Draw' },
  { id: 'polyline', icon: Square, label: 'Polyline' },
  { id: 'scale_area', icon: Ruler, label: 'Scale Area' },
];

const EditModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSave: (value: string) => void;
  initialValue: string;
  title: string;
}> = ({ isOpen, onClose, onSave, initialValue, title }) => {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (isOpen) setValue(initialValue);
  }, [isOpen, initialValue]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-raised rounded-xl shadow-2xl p-6 w-96 max-w-[90vw]">
        <h3 className="text-lg font-semibold mb-4 text-ink">{title}</h3>
        <textarea
          className="w-full h-32 p-3 border border-edge rounded-lg focus:ring-2 focus:ring-accent-500 focus:border-transparent outline-none resize-none mb-4"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-ink-soft hover:bg-hover rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onSave(value);
              onClose();
            }}
            className="px-4 py-2 bg-accent-600 text-white hover:bg-accent-700 rounded-lg transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

const NoteImage: React.FC<{ element: NoteElement; isSelected: boolean; onSelect: () => void; onChange: (newAttrs: any) => void }> = ({ element, isSelected, onSelect, onChange }) => {
  const [img] = useImage(element.imageUrl || '');
  const shapeRef = useRef<any>(null);
  const trRef = useRef<any>(null);

  useEffect(() => {
    if (isSelected) {
      trRef.current.nodes([shapeRef.current]);
      trRef.current.getLayer().batchDraw();
    }
  }, [isSelected]);

  return (
    <>
      <KonvaImage
        image={img}
        x={element.x}
        y={element.y}
        width={element.width || 200}
        height={element.height || 200}
        rotation={element.rotation || 0}
        scaleX={element.scaleX || 1}
        scaleY={element.scaleY || 1}
        onClick={onSelect}
        onTap={onSelect}
        ref={shapeRef}
        draggable
        onDragEnd={(e) => {
          onChange({
            ...element,
            x: e.target.x(),
            y: e.target.y(),
          });
        }}
        onTransformEnd={(e) => {
          const node = shapeRef.current;
          const scaleX = node.scaleX();
          const scaleY = node.scaleY();
          node.scaleX(1);
          node.scaleY(1);
          onChange({
            ...element,
            x: node.x(),
            y: node.y(),
            width: Math.max(5, node.width() * scaleX),
            height: Math.max(5, node.height() * scaleY),
            rotation: node.rotation(),
          });
        }}
      />
      {isSelected && (
        <Transformer
          ref={trRef}
          boundBoxFunc={(oldBox, newBox) => {
            if (newBox.width < 5 || newBox.height < 5) {
              return oldBox;
            }
            return newBox;
          }}
        />
      )}
    </>
  );
};

const STANDARD_SCALES = [
  { label: '1/16" = 1\'-0"', pixelDistance: 144, realWorldDistance: 16, unit: 'ft' },
  { label: '3/32" = 1\'-0"', pixelDistance: 144, realWorldDistance: 32/3, unit: 'ft' },
  { label: '1/8" = 1\'-0"', pixelDistance: 144, realWorldDistance: 8, unit: 'ft' },
  { label: '3/16" = 1\'-0"', pixelDistance: 144, realWorldDistance: 16/3, unit: 'ft' },
  { label: '1/4" = 1\'-0"', pixelDistance: 144, realWorldDistance: 4, unit: 'ft' },
  { label: '3/8" = 1\'-0"', pixelDistance: 144, realWorldDistance: 8/3, unit: 'ft' },
  { label: '1/2" = 1\'-0"', pixelDistance: 144, realWorldDistance: 2, unit: 'ft' },
  { label: '3/4" = 1\'-0"', pixelDistance: 144, realWorldDistance: 4/3, unit: 'ft' },
  { label: '1" = 1\'-0"', pixelDistance: 144, realWorldDistance: 1, unit: 'ft' },
  { label: '1 1/2" = 1\'-0"', pixelDistance: 144, realWorldDistance: 2/3, unit: 'ft' },
  { label: '3" = 1\'-0"', pixelDistance: 144, realWorldDistance: 1/3, unit: 'ft' },
  { label: '1" = 10\'', pixelDistance: 144, realWorldDistance: 10, unit: 'ft' },
  { label: '1" = 20\'', pixelDistance: 144, realWorldDistance: 20, unit: 'ft' },
  { label: '1" = 30\'', pixelDistance: 144, realWorldDistance: 30, unit: 'ft' },
  { label: '1" = 40\'', pixelDistance: 144, realWorldDistance: 40, unit: 'ft' },
  { label: '1" = 50\'', pixelDistance: 144, realWorldDistance: 50, unit: 'ft' },
  { label: '1" = 60\'', pixelDistance: 144, realWorldDistance: 60, unit: 'ft' },
];

const NoteText: React.FC<{ element: NoteElement; isSelected: boolean; onSelect: () => void; onChange: (newAttrs: any) => void; stageRef: any }> = ({ element, isSelected, onSelect, onChange, stageRef }) => {
  const shapeRef = useRef<any>(null);
  const trRef = useRef<any>(null);
  const [isEditing, setIsEditing] = useState(false);
  const isFirstRender = useRef(true);

  const handleTextEdit = (e?: any) => {
    if (isEditing) return;
    setIsEditing(true);
    const stage = stageRef.current;
    const textNode = shapeRef.current;
    const textPosition = textNode.getAbsolutePosition();
    const stageBox = stage.container().getBoundingClientRect();

    const areaPosition = {
      x: stageBox.left + textPosition.x,
      y: stageBox.top + textPosition.y,
    };

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);

    const content = element.content === 'Type here...' ? '' : (element.content || '');
    textarea.value = content;
    textarea.style.position = 'absolute';
    textarea.style.top = areaPosition.y + 'px';
    textarea.style.left = areaPosition.x + 'px';
    textarea.style.width = (Math.max(nodeWidth(textNode), 100) * stage.scaleX()) + 'px';
    textarea.style.height = (Math.max(textNode.height(), 24) * stage.scaleY()) + 'px';
    textarea.style.fontSize = (element.fontSize || 20) * stage.scaleX() + 'px';
    textarea.style.border = 'none';
    textarea.style.padding = '0px';
    textarea.style.margin = '0px';
    textarea.style.overflow = 'hidden';
    textarea.style.background = 'none';
    textarea.style.outline = 'none';
    textarea.style.resize = 'none';
    textarea.style.lineHeight = textNode.lineHeight();
    textarea.style.fontFamily = textNode.fontFamily();
    textarea.style.transformOrigin = 'left top';
    textarea.style.textAlign = textNode.align();
    textarea.style.color = isLink ? '#3b82f6' : (element.color || '#000');
    textarea.style.zIndex = '10000';
    textarea.style.whiteSpace = 'pre';
    textarea.style.wordWrap = 'normal';

    const autoResize = () => {
      const font = `${(element.fontSize || 20) * stage.scaleX()}px ${textNode.fontFamily()}`;
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (context) {
        context.font = font;
        const lines = textarea.value.split('\n');
        let maxWidth = 0;
        lines.forEach(line => {
          const metrics = context.measureText(line);
          maxWidth = Math.max(maxWidth, metrics.width);
        });
        
        // Add some padding for the caret
        const newWidth = Math.max(maxWidth + 20, 100 * stage.scaleX());
        textarea.style.width = newWidth + 'px';
        
        // Height based on line count
        const lineHeight = (element.fontSize || 20) * 1.2 * stage.scaleX();
        textarea.style.height = Math.max(lines.length * lineHeight, 24 * stage.scaleY()) + 'px';
      }
    };

    textarea.addEventListener('input', autoResize);
    autoResize();

    textarea.focus();

    // Heuristic for caret placement
    if (e && e.evt) {
      const pointer = stage.getPointerPosition();
      if (pointer) {
        const clickX = (pointer.x - textPosition.x) / stage.scaleX();
        const font = `${element.fontSize || 20}px ${textNode.fontFamily()}`;
        
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (context) {
          context.font = font;
          let charIndex = 0;
          let currentWidth = 0;
          for (let i = 0; i < content.length; i++) {
            const charWidth = context.measureText(content[i]).width;
            if (currentWidth + charWidth / 2 > clickX) {
              charIndex = i;
              break;
            }
            currentWidth += charWidth;
            charIndex = i + 1;
          }
          textarea.setSelectionRange(charIndex, charIndex);
        }
      }
    }

    function nodeWidth(node: any) {
      return node.width() || 100;
    }

    const removeTextarea = () => {
      textarea.parentNode?.removeChild(textarea);
      window.removeEventListener('mousedown', handleOutsideClick);
      textarea.removeEventListener('input', autoResize);
      setIsEditing(false);
    };

    const handleOutsideClick = (e: MouseEvent) => {
      if (e.target !== textarea) {
        const newVal = textarea.value.trim();
        onChange({ 
          ...element, 
          content: newVal || 'Type here...', 
          isNew: false,
          width: undefined,
          height: undefined
        });
        removeTextarea();
      }
    };

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const newVal = textarea.value.trim();
        onChange({ 
          ...element, 
          content: newVal || 'Type here...', 
          isNew: false,
          width: undefined,
          height: undefined
        });
        removeTextarea();
      }
      if (e.key === 'Escape') {
        removeTextarea();
      }
    });

    setTimeout(() => {
      window.addEventListener('mousedown', handleOutsideClick);
    }, 0);
  };

  useEffect(() => {
    if (isSelected && trRef.current) {
      trRef.current.nodes([shapeRef.current]);
      trRef.current.getLayer().batchDraw();
    }
  }, [isSelected]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      if (element.isNew) {
        setTimeout(handleTextEdit, 50);
      }
    }
  }, [element.isNew]);

  const isLink = element.content?.match(/^(https?:\/\/|www\.)/i);

  return (
    <>
      <Text
        text={element.content || 'Type here...'}
        x={element.x}
        y={element.y}
        fontSize={element.fontSize || 20}
        fill={isLink ? '#3b82f6' : (element.color || '#000')}
        textDecoration={isLink ? 'underline' : 'none'}
        width={element.width}
        height={element.height}
        rotation={element.rotation || 0}
        visible={!isEditing}
        onMouseEnter={(e) => {
          const stage = e.target.getStage();
          if (stage) stage.container().style.cursor = 'text';
        }}
        onMouseLeave={(e) => {
          const stage = e.target.getStage();
          if (stage) stage.container().style.cursor = 'default';
        }}
        onClick={(e) => {
          if (isLink && e.evt.ctrlKey) {
            window.open(element.content?.startsWith('http') ? element.content : `https://${element.content}`, '_blank');
          }
          onSelect();
          handleTextEdit(e);
        }}
        onTap={() => {
          onSelect();
          handleTextEdit();
        }}
        ref={shapeRef}
        draggable
        onDragEnd={(e) => {
          onChange({
            ...element,
            x: e.target.x(),
            y: e.target.y(),
          });
        }}
        onTransformEnd={(e) => {
          const node = shapeRef.current;
          const scaleX = node.scaleX();
          const scaleY = node.scaleY();
          node.scaleX(1);
          node.scaleY(1);
          onChange({
            ...element,
            x: node.x(),
            y: node.y(),
            width: Math.max(5, node.width() * scaleX),
            height: Math.max(5, node.height() * scaleY),
            rotation: node.rotation(),
          });
        }}
      />
      {isSelected && !isEditing && (
        <Transformer
          ref={trRef}
          enabledAnchors={['middle-left', 'middle-right']}
          boundBoxFunc={(oldBox, newBox) => {
            newBox.width = Math.max(30, newBox.width);
            return newBox;
          }}
        />
      )}
    </>
  );
};

const evaluateCell = (cell: string, rows: string[][]) => {
  if (typeof cell !== 'string' || !cell.startsWith('=')) return cell;
  
  try {
    let formula = cell.substring(1).toUpperCase();
    
    // Replace cell references like A1, B2 with values
    // This is a simple regex for A-Z followed by numbers
    formula = formula.replace(/([A-Z])(\d+)/g, (match, colStr, rowStr) => {
      const colIndex = colStr.charCodeAt(0) - 65;
      const rowIndex = parseInt(rowStr) - 1;
      
      if (rows[rowIndex] && rows[rowIndex][colIndex] !== undefined) {
        const val = rows[rowIndex][colIndex];
        // If the referenced cell is also a formula, we don't handle recursion here for simplicity
        return isNaN(Number(val)) ? '0' : val;
      }
      return '0';
    });
    
    // Basic math evaluation
    // We only allow numbers and basic operators for safety
    if (/^[0-9+\-*/().\s]+$/.test(formula)) {
      // eslint-disable-next-line no-new-func
      return new Function(`return ${formula}`)().toString();
    }
    return '#REF!';
  } catch (e) {
    return '#ERROR';
  }
};

const NoteTable: React.FC<{ element: NoteElement; isSelected: boolean; onSelect: () => void; onChange: (newAttrs: any) => void; stageRef: any; currentTool: string }> = ({ element, isSelected, onSelect, onChange, stageRef, currentTool }) => {
  const shapeRef = useRef<any>(null);
  const trRef = useRef<any>(null);
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const data = useMemo(() => {
    try {
      return JSON.parse(element.content || '{"rows":[["Header 1","Header 2"],["Cell 1","Cell 2"]]}');
    } catch (e) {
      return { rows: [['Error', 'Data']] };
    }
  }, [element.content]);

  useEffect(() => {
    if (isSelected && trRef.current) {
      trRef.current.nodes([shapeRef.current]);
      trRef.current.getLayer().batchDraw();
    }
  }, [isSelected]);

  const cellWidth = (element.width || 300) / data.rows[0].length;
  const cellHeight = (element.height || 100) / data.rows.length;

  const handleCellEdit = (rowIndex: number, colIndex: number, cellValue: string) => {
    setEditingCell({ row: rowIndex, col: colIndex });
    const stage = stageRef.current;
    const tableNode = shapeRef.current;
    const tablePosition = tableNode.getAbsolutePosition();
    const stageBox = stage.container().getBoundingClientRect();

    const cellX = tablePosition.x + (colIndex * cellWidth * stage.scaleX());
    const cellY = tablePosition.y + (rowIndex * cellHeight * stage.scaleY());

    const input = document.createElement('input');
    document.body.appendChild(input);

    input.value = cellValue;
    input.style.position = 'absolute';
    input.style.top = (stageBox.top + cellY) + 'px';
    input.style.left = (stageBox.left + cellX) + 'px';
    input.style.width = (cellWidth * stage.scaleX()) + 'px';
    input.style.height = (cellHeight * stage.scaleY()) + 'px';
    input.style.fontSize = (12 * stage.scaleX()) + 'px';
    input.style.border = '2px solid #3b82f6';
    input.style.padding = '0px';
    input.style.margin = '0px';
    input.style.outline = 'none';
    input.style.zIndex = '10000';
    input.style.textAlign = 'center';
    input.style.background = 'white';

    input.focus();
    input.select();

    const saveAndClose = (nextCell?: { row: number; col: number }) => {
      const newRows = [...data.rows];
      newRows[rowIndex] = [...newRows[rowIndex]];
      newRows[rowIndex][colIndex] = input.value;
      onChange({ ...element, content: JSON.stringify({ rows: newRows }) });
      
      input.parentNode?.removeChild(input);
      window.removeEventListener('mousedown', handleOutsideClick);
      setEditingCell(null);

      if (nextCell) {
        // Delay slightly to allow state to update and Konva to re-render
        setTimeout(() => {
          const nextRow = Math.max(0, Math.min(nextCell.row, newRows.length - 1));
          const nextCol = Math.max(0, Math.min(nextCell.col, newRows[0].length - 1));
          handleCellEdit(nextRow, nextCol, newRows[nextRow][nextCol]);
        }, 50);
      }
    };

    const handleOutsideClick = (e: MouseEvent) => {
      if (e.target !== input) {
        saveAndClose();
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveAndClose({ row: rowIndex + (e.shiftKey ? -1 : 1), col: colIndex });
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        saveAndClose({ row: rowIndex, col: colIndex + (e.shiftKey ? -1 : 1) });
      }
      if (e.key === 'Escape') {
        input.parentNode?.removeChild(input);
        window.removeEventListener('mousedown', handleOutsideClick);
        setEditingCell(null);
      }
    });

    setTimeout(() => {
      window.addEventListener('mousedown', handleOutsideClick);
    }, 0);
  };

  const addRow = () => {
    const newRows = [...data.rows, new Array(data.rows[0].length).fill('')];
    onChange({ ...element, content: JSON.stringify({ rows: newRows }), height: (element.height || 100) + cellHeight });
  };

  const addCol = () => {
    const newRows = data.rows.map((r: string[]) => [...r, '']);
    onChange({ ...element, content: JSON.stringify({ rows: newRows }), width: (element.width || 300) + cellWidth });
  };

  const removeRow = () => {
    if (data.rows.length <= 1) return;
    const newRows = data.rows.slice(0, -1);
    onChange({ ...element, content: JSON.stringify({ rows: newRows }), height: (element.height || 100) - cellHeight });
  };

  const removeCol = () => {
    if (data.rows[0].length <= 1) return;
    const newRows = data.rows.map((r: string[]) => r.slice(0, -1));
    onChange({ ...element, content: JSON.stringify({ rows: newRows }), width: (element.width || 300) - cellWidth });
  };

  const tableWidth = element.width || 300;
  const tableHeight = element.height || 100;

  return (
    <>
      <Group
        x={element.x}
        y={element.y}
        width={tableWidth}
        height={tableHeight}
        ref={shapeRef}
        draggable
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={(e) => {
          onChange({ ...element, x: e.target.x(), y: e.target.y() });
        }}
      >
        {data.rows.map((row: string[], rowIndex: number) => (
          row.map((cell: string, colIndex: number) => {
            const displayValue = evaluateCell(cell, data.rows);
            const isEditing = editingCell?.row === rowIndex && editingCell?.col === colIndex;
            return (
              <Group 
                key={`${rowIndex}-${colIndex}`} 
                x={colIndex * cellWidth} 
                y={rowIndex * cellHeight}
                onDblClick={() => handleCellEdit(rowIndex, colIndex, cell)}
                onClick={() => {
                  if (currentTool === 'select') {
                    handleCellEdit(rowIndex, colIndex, cell);
                  }
                }}
              >
                <Rect
                  width={cellWidth}
                  height={cellHeight}
                  stroke="#ccc"
                  fill={rowIndex === 0 ? '#f8fafc' : '#fff'}
                  visible={!isEditing}
                />
                <Text
                  text={displayValue}
                  width={cellWidth}
                  height={cellHeight}
                  padding={5}
                  fontSize={12}
                  verticalAlign="middle"
                  align="center"
                  visible={!isEditing}
                />
                {/* Row Labels (1, 2, 3...) */}
                {isSelected && colIndex === 0 && (
                  <Text
                    text={(rowIndex + 1).toString()}
                    x={-15}
                    y={0}
                    width={15}
                    height={cellHeight}
                    fontSize={10}
                    fill="#94a3b8"
                    verticalAlign="middle"
                    align="right"
                    padding={2}
                  />
                )}
                {/* Column Labels (A, B, C...) */}
                {isSelected && rowIndex === 0 && (
                  <Text
                    text={String.fromCharCode(65 + colIndex)}
                    x={0}
                    y={-15}
                    width={cellWidth}
                    height={15}
                    fontSize={10}
                    fill="#94a3b8"
                    verticalAlign="bottom"
                    align="center"
                    padding={2}
                  />
                )}
              </Group>
            );
          })
        ))}
        {isSelected && (
          <>
            {/* Add Row Button (Bottom) */}
            <Group x={tableWidth / 2} y={tableHeight + 10} onClick={addRow}>
              <Circle radius={10} fill="#3b82f6" shadowBlur={2} />
              <Text text="+" fill="white" fontSize={14} x={-4} y={-7} listening={false} />
            </Group>
            
            {/* Add Column Button (Right) */}
            <Group x={tableWidth + 10} y={tableHeight / 2} onClick={addCol}>
              <Circle radius={10} fill="#3b82f6" shadowBlur={2} />
              <Text text="+" fill="white" fontSize={14} x={-4} y={-7} listening={false} />
            </Group>

            {/* Remove Row Button (Top) */}
            <Group x={tableWidth / 2} y={-10} onClick={removeRow}>
              <Circle radius={10} fill="#ef4444" shadowBlur={2} />
              <Text text="-" fill="white" fontSize={14} x={-4} y={-8} listening={false} />
            </Group>

            {/* Remove Column Button (Left) */}
            <Group x={-10} y={tableHeight / 2} onClick={removeCol}>
              <Circle radius={10} fill="#ef4444" shadowBlur={2} />
              <Text text="-" fill="white" fontSize={14} x={-4} y={-8} listening={false} />
            </Group>
          </>
        )}
      </Group>
      {isSelected && (
        <Transformer
          ref={trRef}
          rotateEnabled={false}
          flipEnabled={false}
          borderVisible={false}
          anchorSize={8}
          anchorCornerRadius={4}
          anchorStroke="#3b82f6"
          anchorFill="white"
          padding={5}
          onTransformEnd={() => {
            const node = shapeRef.current;
            const scaleX = node.scaleX();
            const scaleY = node.scaleY();
            
            node.scaleX(1);
            node.scaleY(1);
            
            onChange({
              ...element,
              x: node.x(),
              y: node.y(),
              width: Math.max(50, tableWidth * scaleX),
              height: Math.max(30, tableHeight * scaleY),
            });
          }}
          boundBoxFunc={(oldBox, newBox) => {
            newBox.width = Math.max(50, newBox.width);
            newBox.height = Math.max(30, newBox.height);
            return newBox;
          }}
        />
      )}
    </>
  );
};

const NoteDrawing: React.FC<{ element: NoteElement; isSelected: boolean; onSelect: () => void; onChange: (newAttrs: any) => void; measurement?: string }> = ({ element, isSelected, onSelect, onChange, measurement }) => {
  const shapeRef = useRef<any>(null);
  const trRef = useRef<any>(null);

  useEffect(() => {
    if (isSelected && trRef.current) {
      trRef.current.nodes([shapeRef.current]);
      trRef.current.getLayer().batchDraw();
    }
  }, [isSelected]);

  return (
    <>
      <Group 
        x={element.x} 
        y={element.y} 
        draggable 
        ref={shapeRef}
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={(e) => onChange({ ...element, x: e.target.x(), y: e.target.y() })}
        onTransformEnd={() => {
          const node = shapeRef.current;
          const scaleX = node.scaleX();
          const scaleY = node.scaleY();
          
          // Update points and reset scale
          const newPoints = element.data.points.map((p: number, i: number) => 
            i % 2 === 0 ? p * scaleX : p * scaleY
          );
          
          node.scaleX(1);
          node.scaleY(1);
          
          onChange({
            ...element,
            x: node.x(),
            y: node.y(),
            data: {
              ...element.data,
              points: newPoints
            },
            rotation: node.rotation(),
          });
        }}
      >
        <Line
          points={element.data.points}
          stroke={element.color || '#3b82f6'}
          strokeWidth={element.strokeWidth || 3}
          tension={element.type === 'drawing' ? 0.5 : 0}
          lineCap="round"
          lineJoin="round"
          rotation={element.rotation || 0}
          hitStrokeWidth={20}
        />
        {measurement && (
          <Text
            text={measurement}
            x={element.data.points[0]}
            y={element.data.points[1] - 20}
            fontSize={12}
            fill="#3b82f6"
            fontStyle="bold"
          />
        )}
      </Group>
      {isSelected && (
        <Transformer
          ref={trRef}
          rotateEnabled={true}
        />
      )}
    </>
  );
};

const ScaleArea: React.FC<{ element: NoteElement; isSelected: boolean; onSelect: () => void; onChange: (newAttrs: any) => void; onEdit: (title: string, initial: string, save: (v: string) => void) => void }> = ({ element, isSelected, onSelect, onChange, onEdit }) => {
  const shapeRef = useRef<any>(null);
  const trRef = useRef<any>(null);
  const [showScaleOptions, setShowScaleOptions] = useState(false);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibrationStart, setCalibrationStart] = useState<{ x: number, y: number } | null>(null);
  const [calibrationEnd, setCalibrationEnd] = useState<{ x: number, y: number } | null>(null);

  useEffect(() => {
    if (isSelected && trRef.current) {
      trRef.current.nodes([shapeRef.current]);
      trRef.current.getLayer().batchDraw();
    }
  }, [isSelected]);

  const handleCalibrationStart = (e: any) => {
    if (!isCalibrating) return;
    const stage = e.target.getStage();
    const pos = stage.getRelativePointerPosition();
    setCalibrationStart(pos);
    setCalibrationEnd(pos);
  };

  const handleCalibrationMove = (e: any) => {
    if (!isCalibrating || !calibrationStart) return;
    const stage = e.target.getStage();
    const pos = stage.getRelativePointerPosition();
    // Force vertical line
    setCalibrationEnd({ x: calibrationStart.x, y: pos.y });
  };

  const handleCalibrationEnd = () => {
    if (!isCalibrating || !calibrationStart || !calibrationEnd) return;
    const pixelDistance = Math.abs(calibrationEnd.y - calibrationStart.y);
    if (pixelDistance > 5) {
      onEdit('Enter real world distance for this line', '10', (distance) => {
        onEdit('Enter unit (e.g. ft, m)', element.data.scale.unit, (unit) => {
          onChange({
            ...element,
            data: {
              ...element.data,
              scale: {
                pixelDistance,
                realWorldDistance: parseFloat(distance),
                unit,
                label: 'custom (calibrated)'
              }
            }
          });
          setIsCalibrating(false);
          setCalibrationStart(null);
          setCalibrationEnd(null);
        });
      });
    } else {
      setIsCalibrating(false);
      setCalibrationStart(null);
      setCalibrationEnd(null);
    }
  };

  return (
    <>
      <Group
        x={element.x}
        y={element.y}
        width={element.width || 300}
        height={element.height || 200}
        ref={shapeRef}
        draggable={!isCalibrating}
        onDragEnd={(e) => onChange({ ...element, x: e.target.x(), y: e.target.y() })}
        onMouseDown={handleCalibrationStart}
        onMouseMove={handleCalibrationMove}
        onMouseUp={handleCalibrationEnd}
      >
        {/* Main area - non-listening for clicks but visible */}
        <Rect
          width={element.width || 300}
          height={element.height || 200}
          fill="rgba(59, 130, 246, 0.02)"
          stroke="#3b82f6"
          strokeWidth={1}
          dash={[10, 5]}
          listening={false}
        />
        
        {/* Handle area - top left, listening for clicks/dblclicks */}
        <Group 
          onClick={onSelect}
          onTap={onSelect}
          onDblClick={() => setShowScaleOptions(true)}
        >
          <Rect
            width={120}
            height={40}
            fill="#3b82f6"
            opacity={0.1}
            cornerRadius={4}
          />
          <Text
            text={`Scale: ${element.data.scale.label || `${element.data.scale.realWorldDistance} ${element.data.scale.unit}`}`}
            fontSize={10}
            fill="#3b82f6"
            padding={5}
            fontStyle="bold"
          />
        </Group>

        {isCalibrating && calibrationStart && calibrationEnd && (
          <Line
            points={[calibrationStart.x - element.x, calibrationStart.y - element.y, calibrationEnd.x - element.x, calibrationEnd.y - element.y]}
            stroke="#ef4444"
            strokeWidth={2}
          />
        )}

        {showScaleOptions && (
          <Group y={-240} x={0}>
            <Rect width={300} height={230} fill="white" stroke="#ccc" shadowBlur={10} cornerRadius={8} />
            <Text text="Select Standard Scale" fontSize={14} fontStyle="bold" padding={10} />
            <Group y={30}>
              {STANDARD_SCALES.slice(0, 8).map((scale, i) => (
                <Group key={scale.label} y={i * 20} onClick={() => {
                  onChange({
                    ...element,
                    data: {
                      ...element.data,
                      scale: {
                        pixelDistance: scale.pixelDistance,
                        realWorldDistance: scale.realWorldDistance,
                        unit: scale.unit,
                        label: scale.label
                      }
                    }
                  });
                  setShowScaleOptions(false);
                }}>
                  <Rect width={300} height={20} fill={i % 2 === 0 ? '#f8fafc' : '#fff'} />
                  <Text text={scale.label} fontSize={10} padding={5} />
                </Group>
              ))}
              <Group y={160} onClick={() => {
                setShowScaleOptions(false);
                onEdit('Enter real world distance', String(element.data.scale.realWorldDistance), (distance) => {
                  onEdit('Enter unit (e.g. ft, m)', element.data.scale.unit, (unit) => {
                    onChange({
                      ...element,
                      data: {
                        ...element.data,
                        scale: {
                          ...element.data.scale,
                          realWorldDistance: parseFloat(distance),
                          unit,
                          label: 'custom'
                        }
                      }
                    });
                  });
                });
              }}>
                <Rect width={300} height={30} fill="#3b82f6" opacity={0.1} />
                <Text text="Custom Calibration..." fill="#3b82f6" fontSize={12} padding={8} align="center" width={300} />
              </Group>
              <Group y={190} onClick={() => {
                setShowScaleOptions(false);
                setIsCalibrating(true);
              }}>
                <Rect width={300} height={30} fill="#10b981" opacity={0.1} />
                <Text text="Calibrate with Vertical Line..." fill="#10b981" fontSize={12} padding={8} align="center" width={300} />
              </Group>
            </Group>
          </Group>
        )}
      </Group>
      {isSelected && (
        <Transformer
          ref={trRef}
          rotateEnabled={false}
          flipEnabled={false}
          borderVisible={false}
          anchorSize={8}
          anchorCornerRadius={4}
          anchorStroke="#3b82f6"
          anchorFill="white"
          padding={5}
          onTransformEnd={() => {
            const node = shapeRef.current;
            const scaleX = node.scaleX();
            const scaleY = node.scaleY();
            node.scaleX(1);
            node.scaleY(1);
            onChange({
              ...element,
              x: node.x(),
              y: node.y(),
              width: (element.width || 300) * scaleX,
              height: (element.height || 200) * scaleY,
            });
          }}
          boundBoxFunc={(oldBox, newBox) => {
            newBox.width = Math.max(100, newBox.width);
            newBox.height = Math.max(50, newBox.height);
            return newBox;
          }}
        />
      )}
    </>
  );
};

export const NotesBoard: React.FC<NotesBoardProps> = ({ projectId, initialNote, onSave }) => {
  const [elements, setElements] = useState<NoteElement[]>(initialNote?.elements || []);
  const [viewport, setViewport] = useState(initialNote?.viewport || { x: 0, y: 0, zoom: 1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentTool, setCurrentTool] = useState<string>('select');
  const [isDrawing, setIsDrawing] = useState(false);
  const [newDrawingPoints, setNewDrawingPoints] = useState<number[]>([]);
  const [isPanning, setIsPanning] = useState(false);
  const [lastPointerPos, setLastPointerPos] = useState({ x: 0, y: 0 });
  const [mouseDownPos, setMouseDownPos] = useState({ x: 0, y: 0 });
  const [isPolylineActive, setIsPolylineActive] = useState(false);
  const [polylinePoints, setPolylinePoints] = useState<number[]>([]);
  const [showGrid, setShowGrid] = useState(true);
  const [history, setHistory] = useState<NoteElement[][]>([initialNote?.elements || []]);
  const [historyStep, setHistoryStep] = useState(0);
  const [clipboard, setClipboard] = useState<NoteElement | null>(null);
  const [editConfig, setEditConfig] = useState<{
    isOpen: boolean;
    title: string;
    initialValue: string;
    onSave: (val: string) => void;
  }>({
    isOpen: false,
    title: '',
    initialValue: '',
    onSave: () => {},
  });

  const stageRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  const openEdit = (title: string, initialValue: string, onSave: (val: string) => void) => {
    setEditConfig({ isOpen: true, title, initialValue, onSave });
  };

  const getRelativePointerPosition = () => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const pointer = stage.getPointerPosition();
    if (!pointer) return { x: 0, y: 0 };
    
    // Calculate position relative to the stage's current transform (zoom and pan)
    return {
      x: (pointer.x - stage.x()) / stage.scaleX(),
      y: (pointer.y - stage.y()) / stage.scaleY(),
    };
  };

  useEffect(() => {
    if (!containerRef.current) return;
    
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const addToHistory = (newElements: NoteElement[]) => {
    const newHistory = history.slice(0, historyStep + 1);
    newHistory.push([...newElements]);
    setHistory(newHistory);
    setHistoryStep(newHistory.length - 1);
  };

  const undo = () => {
    if (historyStep > 0) {
      const prevStep = historyStep - 1;
      setHistoryStep(prevStep);
      setElements([...history[prevStep]]);
      handleSave(history[prevStep]);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId) {
          const newElements = elements.filter(el => el.id !== selectedId);
          setElements(newElements);
          setSelectedId(null);
          addToHistory(newElements);
          handleSave(newElements);
        }
      }

      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'c') {
          const selected = elements.find(el => el.id === selectedId);
          if (selected) {
            setClipboard(selected);
          }
        }
        if (e.key === 'z') {
          e.preventDefault();
          undo();
        }
      }
    };

    const handlePaste = async (e: ClipboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.indexOf('image') !== -1) {
            const file = items[i].getAsFile();
            if (file) {
              const reader = new FileReader();
              reader.onload = (event) => {
                const dataUrl = event.target?.result as string;
                const stage = stageRef.current;
                const scale = stage.scaleX();
                const center = {
                  x: (-stage.x() + stage.width() / 2) / scale,
                  y: (-stage.y() + stage.height() / 2) / scale,
                };
                
                const newElement: NoteElement = {
                  id: uuidv4(),
                  type: 'image',
                  x: center.x - 150,
                  y: center.y - 150,
                  imageUrl: dataUrl,
                  width: 300,
                  height: 300,
                };
                const newElements = [...elements, newElement];
                setElements(newElements);
                setSelectedId(newElement.id);
                addToHistory(newElements);
                handleSave(newElements);
              };
              reader.readAsDataURL(file);
              return;
            }
          }
        }
      }

      const text = e.clipboardData?.getData('text/plain');
      if (text) {
        const stage = stageRef.current;
        const scale = stage.scaleX();
        const center = {
          x: (-stage.x() + stage.width() / 2) / scale,
          y: (-stage.y() + stage.height() / 2) / scale,
        };

        if (text.includes('\t')) {
          const rows = text.split('\n').filter(r => r.trim()).map(row => row.split('\t'));
          const newElement: NoteElement = {
            id: uuidv4(),
            type: 'table',
            x: center.x - 150,
            y: center.y - 50,
            content: JSON.stringify({ rows }),
            width: rows[0].length * 100,
            height: rows.length * 30,
          };
          const newElements = [...elements, newElement];
          setElements(newElements);
          setSelectedId(newElement.id);
          addToHistory(newElements);
          handleSave(newElements);
        } else {
          const newElement: NoteElement = {
            id: uuidv4(),
            type: 'text',
            x: center.x,
            y: center.y,
            content: text,
            fontSize: 20,
          };
          const newElements = [...elements, newElement];
          setElements(newElements);
          setSelectedId(newElement.id);
          addToHistory(newElements);
          handleSave(newElements);
        }
        return;
      }

      if (clipboard) {
        const stage = stageRef.current;
        const scale = stage.scaleX();
        const center = {
          x: (-stage.x() + stage.width() / 2) / scale,
          y: (-stage.y() + stage.height() / 2) / scale,
        };
        const newElement = {
          ...clipboard,
          id: uuidv4(),
          x: center.x,
          y: center.y,
        };
        const newElements = [...elements, newElement];
        setElements(newElements);
        setSelectedId(newElement.id);
        addToHistory(newElements);
        handleSave(newElements);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('paste', handlePaste);
    };
  }, [selectedId, elements, clipboard, history, historyStep]);

  const handleSave = (newElements?: NoteElement[], newViewport?: typeof viewport) => {
    const note: ProjectNote = {
      id: initialNote?.id || uuidv4(),
      projectId,
      elements: newElements || elements,
      viewport: newViewport || viewport,
      createdAt: initialNote?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    onSave(note);
  };

  const handleWheel = (e: any) => {
    e.evt.preventDefault();
    const scaleBy = 1.1;
    const stage = stageRef.current;
    const oldScale = stage.scaleX();
    const pointer = stage.getPointerPosition();

    const mousePointTo = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale,
    };

    const newScale = e.evt.deltaY < 0 ? oldScale * scaleBy : oldScale / scaleBy;

    stage.scale({ x: newScale, y: newScale });

    const newPos = {
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    };
    stage.position(newPos);
    const updatedViewport = { x: newPos.x, y: newPos.y, zoom: newScale };
    setViewport(updatedViewport);
    handleSave(undefined, updatedViewport);
  };

  const handleMouseDown = (e: any) => {
    const pointerPos = stageRef.current.getPointerPosition();
    setMouseDownPos(pointerPos);

    // Middle mouse button (button 1) always pans
    if (e.evt.button === 1 || (e.evt.button === 0 && e.evt.spaceKey) || currentTool === 'pan') {
      setIsPanning(true);
      setLastPointerPos(pointerPos);
      return;
    }

    if (currentTool === 'drawing') {
      setIsDrawing(true);
      const pos = getRelativePointerPosition();
      setNewDrawingPoints([pos.x, pos.y]);
      return;
    }

    if (currentTool === 'polyline') {
      const pos = getRelativePointerPosition();
      if (!isPolylineActive) {
        setIsPolylineActive(true);
        setPolylinePoints([pos.x, pos.y, pos.x, pos.y]);
      } else {
        // Add new point, but check distance to prevent accidental double point on fast clicks
        const lastX = polylinePoints[polylinePoints.length - 4];
        const lastY = polylinePoints[polylinePoints.length - 3];
        const dist = Math.sqrt(Math.pow(pos.x - lastX, 2) + Math.pow(pos.y - lastY, 2));
        
        if (dist > 2) {
          setPolylinePoints([...polylinePoints.slice(0, -2), pos.x, pos.y, pos.x, pos.y]);
        }
      }
      return;
    }

    if (currentTool !== 'select' && currentTool !== 'pan') {
      const pos = getRelativePointerPosition();
      addElementAt(currentTool as any, pos.x, pos.y, currentTool === 'text');
      setCurrentTool('select');
      return;
    }

    if (e.target === stageRef.current) {
      setSelectedId(null);
      // Pan on blank area in select tool with left click
      if (currentTool === 'select' && e.evt.button === 0) {
        setIsPanning(true);
        setLastPointerPos(stageRef.current.getPointerPosition());
      }
    }
  };

  const handleMouseMove = (e: any) => {
    if (isPanning) {
      const stage = stageRef.current;
      const pos = stage.getPointerPosition();
      const newPos = {
        x: stage.x() + (pos.x - lastPointerPos.x),
        y: stage.y() + (pos.y - lastPointerPos.y),
      };
      stage.position(newPos);
      setLastPointerPos(pos);
      const updatedViewport = { ...viewport, x: newPos.x, y: newPos.y };
      setViewport(updatedViewport);
      handleSave(undefined, updatedViewport);
      return;
    }

    if (isDrawing) {
      const pos = getRelativePointerPosition();
      setNewDrawingPoints([...newDrawingPoints, pos.x, pos.y]);
      return;
    }

    if (isPolylineActive) {
      const pos = getRelativePointerPosition();
      const points = [...polylinePoints];
      points[points.length - 2] = pos.x;
      points[points.length - 1] = pos.y;
      setPolylinePoints(points);
    }
  };

  const handleMouseUp = (e: any) => {
    setIsPanning(false);

    if (isDrawing) {
      setIsDrawing(false);
      const newElement: NoteElement = {
        id: uuidv4(),
        type: 'drawing',
        x: 0,
        y: 0,
        data: { points: newDrawingPoints },
        color: '#3b82f6',
        strokeWidth: 3,
      };
      const updatedElements = [...elements, newElement];
      setElements(updatedElements);
      setNewDrawingPoints([]);
      addToHistory(updatedElements);
      handleSave(updatedElements);
    }
  };

  const handleDblClick = () => {
    if (isPolylineActive) {
      setIsPolylineActive(false);
      const finalPoints = polylinePoints.slice(0, -2);
      if (finalPoints.length >= 4) {
        const newElement: NoteElement = {
          id: uuidv4(),
          type: 'polyline',
          x: 0,
          y: 0,
          data: { points: finalPoints },
          color: '#3b82f6',
          strokeWidth: 3,
        };
        const updatedElements = [...elements, newElement];
        setElements(updatedElements);
        addToHistory(updatedElements);
        handleSave(updatedElements);
      }
      setPolylinePoints([]);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      const stage = stageRef.current;
      const scale = stage.scaleX();
      const center = {
        x: (-stage.x() + stage.width() / 2) / scale,
        y: (-stage.y() + stage.height() / 2) / scale,
      };
      
      const newElement: NoteElement = {
        id: uuidv4(),
        type: 'image',
        x: center.x,
        y: center.y,
        imageUrl: dataUrl,
        width: 300,
        height: 300,
      };
      
      const updatedElements = [...elements, newElement];
      setElements(updatedElements);
      setSelectedId(newElement.id);
      addToHistory(updatedElements);
      handleSave(updatedElements);
    };
    reader.readAsDataURL(file);
  };

  const addElementAt = (type: NoteElement['type'], x: number, y: number, isNew = false) => {
    if (type === 'image') {
      fileInputRef.current?.click();
      return;
    }

    let newElement: NoteElement = {
      id: uuidv4(),
      type,
      x,
      y,
      isNew,
    };

    if (type === 'text') {
      newElement.content = 'Type here...';
      newElement.fontSize = 20;
    } else if (type === 'scale_area') {
      newElement.width = 300;
      newElement.height = 200;
      newElement.data = {
        scale: { pixelDistance: 100, realWorldDistance: 10, unit: 'ft' }
      };
    } else if (type === 'table') {
      newElement.width = 300;
      newElement.height = 100;
      newElement.content = JSON.stringify({
        rows: [
          ['Header 1', 'Header 2'],
          ['Cell 1', 'Cell 2']
        ]
      });
    }

    const updatedElements = [...elements, newElement];
    setElements(updatedElements);
    setSelectedId(newElement.id);
    addToHistory(updatedElements);
    handleSave(updatedElements);
  };

  const addElement = (type: NoteElement['type']) => {
    const stage = stageRef.current;
    if (!stage) return;

    const scale = stage.scaleX();
    const center = {
      x: (-stage.x() + stage.width() / 2) / scale,
      y: (-stage.y() + stage.height() / 2) / scale,
    };

    addElementAt(type, center.x, center.y);
  };

  const updateElement = (id: string, newAttrs: any) => {
    const newElements = elements.map((el) => (el.id === id ? newAttrs : el));
    setElements(newElements);
    addToHistory(newElements);
    handleSave(newElements);
  };

  const deleteSelected = () => {
    if (selectedId) {
      const newElements = elements.filter((el) => el.id !== selectedId);
      setElements(newElements);
      setSelectedId(null);
      addToHistory(newElements);
      handleSave(newElements);
    }
  };

  return (
    <div className="flex flex-col h-full bg-sunken overflow-hidden relative">
      {/* Toolbar */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 p-1 bg-raised rounded-xl shadow-lg border border-edge">
        {ELEMENT_TYPES.map((tool) => (
          <button
            key={tool.id}
            onClick={() => {
              if (tool.id === 'image') {
                fileInputRef.current?.click();
              } else {
                setCurrentTool(tool.id);
              }
            }}
            className={`p-2 rounded-lg transition-all flex flex-col items-center gap-1 ${
              currentTool === tool.id ? 'bg-accent-50 text-accent-600' : 'text-ink-soft hover:bg-hover'
            }`}
            title={tool.label}
          >
            <tool.icon size={18} />
            <span className="text-[10px] font-medium">{tool.label}</span>
          </button>
        ))}
        <div className="w-px h-8 bg-edge mx-1" />
        <button
          onClick={() => setShowGrid(!showGrid)}
          className={`p-2 rounded-lg transition-all ${
            showGrid ? 'bg-accent-50 text-accent-600' : 'text-ink-soft hover:bg-hover'
          }`}
          title="Toggle Grid"
        >
          <Grid size={18} />
        </button>
        <button
          onClick={deleteSelected}
          disabled={!selectedId}
          className="p-2 rounded-lg text-ink-faint hover:text-red-500 hover:bg-red-50 disabled:opacity-30 transition-all"
        >
          <Trash2 size={18} />
        </button>
      </div>

      {/* Canvas Area */}
      <div className="flex-1 relative bg-raised" ref={containerRef}>
        <input 
          type="file" 
          ref={fileInputRef} 
          className="hidden" 
          accept="image/*" 
          onChange={handleImageUpload}
        />
        <Stage
          width={dimensions.width}
          height={dimensions.height}
          ref={stageRef}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onDblClick={handleDblClick}
          draggable={currentTool === 'pan'}
          scaleX={viewport.zoom}
          scaleY={viewport.zoom}
          x={viewport.x}
          y={viewport.y}
          className={
            currentTool === 'pan' ? 'cursor-grab active:cursor-grabbing' : 
            currentTool === 'drawing' || currentTool === 'polyline' ? 'cursor-crosshair' : 
            currentTool === 'select' ? 'cursor-default' : 
            'cursor-cell'
          }
        >
          <Layer>
            {/* Grid Background */}
            {useMemo(() => {
              if (!showGrid) return null;
              const gridSize = 50;
              const startX = Math.floor(-viewport.x / viewport.zoom / gridSize) * gridSize - gridSize;
              const startY = Math.floor(-viewport.y / viewport.zoom / gridSize) * gridSize - gridSize;
              const endX = startX + (dimensions.width / viewport.zoom) + gridSize * 2;
              const endY = startY + (dimensions.height / viewport.zoom) + gridSize * 2;
              
              const lines = [];
              for (let x = startX; x <= endX; x += gridSize) {
                lines.push(
                  <Line
                    key={`v-${x}`}
                    points={[x, startY, x, endY]}
                    stroke="#e2e8f0"
                    strokeWidth={1 / viewport.zoom}
                  />
                );
              }
              for (let y = startY; y <= endY; y += gridSize) {
                lines.push(
                  <Line
                    key={`h-${y}`}
                    points={[startX, y, endX, y]}
                    stroke="#e2e8f0"
                    strokeWidth={1 / viewport.zoom}
                  />
                );
              }
              return lines;
            }, [viewport, dimensions])}

            {elements.map((el) => {
              if (el.type === 'drawing' || el.type === 'polyline') {
                const scaleArea = elements.find(sa => 
                  sa.type === 'scale_area' &&
                  el.data.points.every((p: number, i: number) => {
                    if (i % 2 === 0) {
                      const x = p + (el.x || 0);
                      const y = el.data.points[i+1] + (el.y || 0);
                      return x >= sa.x && x <= sa.x + (sa.width || 0) &&
                             y >= sa.y && y <= sa.y + (sa.height || 0);
                    }
                    return true;
                  })
                );

                let measurement = '';
                if (scaleArea) {
                  const pointObjects: Point[] = [];
                  for (let i = 0; i < el.data.points.length; i += 2) {
                    pointObjects.push({ x: el.data.points[i], y: el.data.points[i + 1] });
                  }
                  const pixelLength = calculatePolylineLength(pointObjects);
                  const ratio = scaleArea.data.scale.realWorldDistance / scaleArea.data.scale.pixelDistance;
                  measurement = formatMeasurement(pixelLength * ratio, 'length', { pixelDistance: 1, realWorldDistance: 1, unit: scaleArea.data.scale.unit });
                }

                return (
                  <NoteDrawing
                    key={el.id}
                    element={el}
                    isSelected={el.id === selectedId}
                    onSelect={() => setSelectedId(el.id)}
                    onChange={(newAttrs) => updateElement(el.id, newAttrs)}
                    measurement={measurement}
                  />
                );
              }
              if (el.type === 'text') {
                return (
                  <NoteText
                    key={el.id}
                    element={el}
                    isSelected={el.id === selectedId}
                    onSelect={() => setSelectedId(el.id)}
                    onChange={(newAttrs) => updateElement(el.id, newAttrs)}
                    stageRef={stageRef}
                  />
                );
              }
              if (el.type === 'image') {
                return (
                  <NoteImage
                    key={el.id}
                    element={el}
                    isSelected={el.id === selectedId}
                    onSelect={() => setSelectedId(el.id)}
                    onChange={(newAttrs) => updateElement(el.id, newAttrs)}
                  />
                );
              }
              if (el.type === 'scale_area') {
                return (
                  <ScaleArea
                    key={el.id}
                    element={el}
                    isSelected={el.id === selectedId}
                    onSelect={() => setSelectedId(el.id)}
                    onChange={(newAttrs) => updateElement(el.id, newAttrs)}
                    onEdit={openEdit}
                  />
                );
              }
              if (el.type === 'table') {
                return (
                  <NoteTable
                    key={el.id}
                    element={el}
                    isSelected={el.id === selectedId}
                    onSelect={() => setSelectedId(el.id)}
                    onChange={(newAttrs) => updateElement(el.id, newAttrs)}
                    stageRef={stageRef}
                    currentTool={currentTool}
                  />
                );
              }
              return null;
            })}
            {isDrawing && (
              <Line
                points={newDrawingPoints}
                stroke="#3b82f6"
                strokeWidth={3}
                tension={0.5}
                lineCap="round"
                lineJoin="round"
              />
            )}
            {isPolylineActive && (
              <Line
                points={polylinePoints}
                stroke="#3b82f6"
                strokeWidth={3}
                lineCap="round"
                lineJoin="round"
              />
            )}
          </Layer>
        </Stage>
      </div>

      {/* Zoom Controls */}
      <div className="absolute bottom-6 right-6 flex flex-col gap-2">
        <button
          onClick={() => {
            const stage = stageRef.current;
            const newScale = stage.scaleX() * 1.2;
            stage.scale({ x: newScale, y: newScale });
            setViewport({ ...viewport, zoom: newScale });
          }}
          className="p-3 bg-raised rounded-full shadow-lg border border-edge text-ink-soft hover:bg-hover transition-all"
        >
          <ZoomIn size={20} />
        </button>
        <button
          onClick={() => {
            const stage = stageRef.current;
            const newScale = stage.scaleX() / 1.2;
            stage.scale({ x: newScale, y: newScale });
            setViewport({ ...viewport, zoom: newScale });
          }}
          className="p-3 bg-raised rounded-full shadow-lg border border-edge text-ink-soft hover:bg-hover transition-all"
        >
          <ZoomOut size={20} />
        </button>
        <button
          onClick={() => {
            const stage = stageRef.current;
            stage.position({ x: 0, y: 0 });
            stage.scale({ x: 1, y: 1 });
            setViewport({ x: 0, y: 0, zoom: 1 });
          }}
          className="p-3 bg-raised rounded-full shadow-lg border border-edge text-ink-soft hover:bg-hover transition-all"
        >
          <Maximize size={20} />
        </button>
      </div>
      <EditModal
        isOpen={editConfig.isOpen}
        title={editConfig.title}
        initialValue={editConfig.initialValue}
        onSave={editConfig.onSave}
        onClose={() => setEditConfig({ ...editConfig, isOpen: false })}
      />
    </div>
  );
};
