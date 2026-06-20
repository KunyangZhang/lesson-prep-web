#!/usr/bin/env ruby
$LOAD_PATH.unshift(File.expand_path('vendor/mathtype', __dir__))
$LOAD_PATH.unshift(File.expand_path('vendor/mathtype_to_mathml', __dir__))
require 'mathtype_to_mathml'
require 'mathtype'
require 'rexml/document'

def node_text(node)
  return '' unless node
  name = node.respond_to?(:name) ? node.name : ''
  children = node.respond_to?(:elements) ? node.elements.to_a : []
  if %w[mi mn mo mtext].include?(name)
    return node.text.to_s.strip
  end
  if name == 'msup' && children.length >= 2
    return "#{node_text(children[0])}^(#{node_text(children[1])})"
  end
  if name == 'msub' && children.length >= 2
    return "#{node_text(children[0])}_(#{node_text(children[1])})"
  end
  if name == 'msubsup' && children.length >= 3
    return "#{node_text(children[0])}_(#{node_text(children[1])})^(#{node_text(children[2])})"
  end
  if name == 'mfrac' && children.length >= 2
    return "(#{node_text(children[0])})/(#{node_text(children[1])})"
  end
  if name == 'msqrt'
    return "sqrt(#{children.map { |child| node_text(child) }.join})"
  end
  children.map { |child| node_text(child) }.join
end

def raw_mathtype_text(file)
  converter = Mathtype::Converter.new(file)
  doc = REXML::Document.new(converter.to_xml)
  raw_node_text(doc.root)
end

def clean_formula_text(text)
  text.to_s.tr('−', '-').tr('′', "'").strip
end

def char_text(node)
  code = node.elements['mt_code_value']&.text.to_s
  return '' unless code.start_with?('0x')
  code.to_i(16).chr(Encoding::UTF_8)
end

def child_elements(node, name = nil)
  node.elements.to_a.select { |child| name.nil? || child.name == name }
end

def raw_node_text(node)
  return '' unless node
  case node.name
  when 'char'
    char_text(node)
  when 'slot', 'mtef', 'root'
    child_elements(node).reject { |child| metadata_node?(child) }.map { |child| raw_node_text(child) }.join
  when 'tmpl'
    render_template(node)
  else
    child_elements(node).map { |child| raw_node_text(child) }.join
  end
end

def metadata_node?(node)
  %w[
    mtef_version platform product product_version product_subversion application_key
    equation_options encoding_def font_def eqn_prefs font_style_def color_def size
    options typeface variation selector line_spacing end ruler nudge
  ].include?(node.name)
end

def render_template(node)
  selector = node.elements['selector']&.text.to_s
  slots = child_elements(node, 'slot').map { |slot| raw_node_text(slot) }
  case selector
  when 'tmFRACT'
    "(#{slots[0]})/(#{slots[1]})"
  when 'tmROOT'
    slots[1].to_s.empty? ? "sqrt(#{slots[0]})" : "root(#{slots[0]},#{slots[1]})"
  when 'tmSUB'
    "_(#{slots[0]})"
  when 'tmSUP'
    "^(#{slots[0]})"
  when 'tmSUBSUP'
    "_(#{slots[0]})^(#{slots[1]})"
  else
    slots.join
  end
end

def suspicious_formula_text?(text)
  stripped = text.to_s.strip
  stripped.empty? || stripped.include?('[公式]') || stripped.match?(/\(\s*\)|\/\(\s*\)/)
end

ARGV.each do |file|
  begin
    mathml = MathTypeToMathML::Converter.new(file).convert
    doc = REXML::Document.new(mathml)
    text = clean_formula_text(node_text(doc.root))
    if suspicious_formula_text?(text)
      fallback = clean_formula_text(raw_mathtype_text(file))
      puts fallback.empty? ? '[公式]' : fallback
    else
      puts text
    end
  rescue => e
    begin
      fallback = clean_formula_text(raw_mathtype_text(file))
      puts fallback.empty? ? '[公式]' : fallback
    rescue => fallback_error
      warn "#{file}: #{e.message}; fallback: #{fallback_error.message}"
      puts '[公式]'
    end
  end
end
