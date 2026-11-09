<?php
/**
 * Per-post SEO box (standalone mode) on every post, page and public post type.
 *
 * Fields: SEO title, meta description, canonical URL, index/noindex, follow/nofollow,
 * social title, social description, social image. In Yoast SEO / Rank Math mode the box
 * only shows Relaunch72 provenance, because that plugin owns the per-post fields.
 *
 * A value a person saves here on a Relaunch72-managed post is preserved on the next
 * Relaunch72 update (see R72Pub_Seo::apply).
 *
 * @package Relaunch72Publisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class R72Pub_Metabox {
	const NONCE = 'r72pub_meta_box';

	public static function init() {
		add_action( 'add_meta_boxes', array( __CLASS__, 'add' ) );
		add_action( 'save_post', array( __CLASS__, 'save' ), 10, 2 );
	}

	public static function post_types() {
		$types = get_post_types( array( 'public' => true ), 'names' );
		unset( $types['attachment'] );
		return apply_filters( 'r72pub_meta_box_post_types', array_values( $types ) );
	}

	public static function add() {
		foreach ( self::post_types() as $type ) {
			add_meta_box( 'r72pub-seo', __( 'SEO (Relaunch72 Publisher & SEO)', 'relaunch72-publisher' ), array( __CLASS__, 'render' ), $type, 'normal', 'high' );
		}
	}

	public static function render( WP_Post $post ) {
		$mode    = R72Pub_Seo::status()['mode'];
		$managed = '' !== (string) get_post_meta( $post->ID, R72Pub_Publisher::META_ARTICLE, true );
		wp_nonce_field( self::NONCE, self::NONCE );
		if ( $managed ) {
			$preserved = json_decode( (string) get_post_meta( $post->ID, R72Pub_Seo::META_PRESERVE, true ), true );
			echo '<p class="description">' . esc_html__( 'This post is managed by Relaunch72.', 'relaunch72-publisher' ) . ' ' . esc_html(
				/* translators: %s: version number */
				sprintf( __( 'Delivered version %s.', 'relaunch72-publisher' ), (string) get_post_meta( $post->ID, R72Pub_Publisher::META_NUMBER, true ) )
			) . ' ' . esc_html__( 'A field you change here is kept on later Relaunch72 updates.', 'relaunch72-publisher' );
			if ( is_array( $preserved ) && $preserved ) {
				echo ' ' . esc_html__( 'Currently kept from your edits:', 'relaunch72-publisher' ) . ' <code>' . esc_html( implode( ', ', $preserved ) ) . '</code>';
			}
			echo '</p>';
		}
		if ( 'standalone' !== $mode ) {
			$status = R72Pub_Seo::status();
			echo '<p>' . esc_html( $status['message'] ) . ' ' . esc_html__( 'Edit this post\'s SEO values in that plugin\'s own box.', 'relaunch72-publisher' ) . '</p>';
			return;
		}
		$v = array();
		foreach ( R72Pub_Seo::fields() as $key ) {
			$v[ $key ] = get_post_meta( $post->ID, $key, true );
		}
		$preview_title = R72Pub_Seo::render_template( (string) R72Pub_Settings::site_seo()[ 'page' === $post->post_type ? 'title_page' : 'title_post' ], R72Pub_Seo::context_vars( $post ) );
		$image_id      = (int) $v[ R72Pub_Seo::F_OG_IMAGE ];
		$image_url     = $image_id ? wp_get_attachment_image_url( $image_id, 'medium' ) : '';
		?>
		<style>.r72pub-box label{display:block;font-weight:600;margin:10px 0 2px}.r72pub-box input[type=text],.r72pub-box input[type=url],.r72pub-box textarea{width:100%}.r72pub-box .r72pub-hint{color:#50575e;font-size:12px}.r72pub-box .r72pub-count{float:right;font-weight:400}</style>
		<div class="r72pub-box">
			<label for="r72pub-title"><?php esc_html_e( 'SEO title', 'relaunch72-publisher' ); ?> <span class="r72pub-count r72pub-hint" data-for="r72pub-title"></span></label>
			<input type="text" id="r72pub-title" name="r72pub[<?php echo esc_attr( R72Pub_Seo::F_TITLE ); ?>]" value="<?php echo esc_attr( $v[ R72Pub_Seo::F_TITLE ] ); ?>" maxlength="200" placeholder="<?php echo esc_attr( $preview_title ); ?>" />
			<p class="r72pub-hint"><?php esc_html_e( 'Leave blank to use the site title template shown as the placeholder. Around 50–60 characters display fully in most search results.', 'relaunch72-publisher' ); ?></p>

			<label for="r72pub-desc"><?php esc_html_e( 'Meta description', 'relaunch72-publisher' ); ?> <span class="r72pub-count r72pub-hint" data-for="r72pub-desc"></span></label>
			<textarea id="r72pub-desc" name="r72pub[<?php echo esc_attr( R72Pub_Seo::F_DESC ); ?>]" rows="3" maxlength="400"><?php echo esc_textarea( $v[ R72Pub_Seo::F_DESC ] ); ?></textarea>
			<p class="r72pub-hint"><?php esc_html_e( 'Around 120–160 characters. Blank outputs no description tag.', 'relaunch72-publisher' ); ?></p>

			<label for="r72pub-canonical"><?php esc_html_e( 'Canonical URL', 'relaunch72-publisher' ); ?></label>
			<input type="url" id="r72pub-canonical" name="r72pub[<?php echo esc_attr( R72Pub_Seo::F_CANONICAL ); ?>]" value="<?php echo esc_attr( $v[ R72Pub_Seo::F_CANONICAL ] ); ?>" placeholder="<?php echo esc_attr( get_permalink( $post ) ); ?>" />
			<p class="r72pub-hint"><?php esc_html_e( 'Blank uses this post\'s own address. Set only when this content is a copy of a page elsewhere; exactly one canonical tag is output.', 'relaunch72-publisher' ); ?></p>

			<label><?php esc_html_e( 'Search engine directives', 'relaunch72-publisher' ); ?></label>
			<label style="font-weight:400;display:inline;margin-right:16px"><input type="checkbox" name="r72pub[<?php echo esc_attr( R72Pub_Seo::F_NOINDEX ); ?>]" value="1" <?php checked( '1', (string) $v[ R72Pub_Seo::F_NOINDEX ] ); ?> /> <?php esc_html_e( 'noindex (keep out of search results and the sitemap)', 'relaunch72-publisher' ); ?></label>
			<label style="font-weight:400;display:inline"><input type="checkbox" name="r72pub[<?php echo esc_attr( R72Pub_Seo::F_NOFOLLOW ); ?>]" value="1" <?php checked( '1', (string) $v[ R72Pub_Seo::F_NOFOLLOW ] ); ?> /> <?php esc_html_e( 'nofollow', 'relaunch72-publisher' ); ?></label>

			<label for="r72pub-og-title"><?php esc_html_e( 'Social title', 'relaunch72-publisher' ); ?></label>
			<input type="text" id="r72pub-og-title" name="r72pub[<?php echo esc_attr( R72Pub_Seo::F_OG_TITLE ); ?>]" value="<?php echo esc_attr( $v[ R72Pub_Seo::F_OG_TITLE ] ); ?>" maxlength="200" />
			<label for="r72pub-og-desc"><?php esc_html_e( 'Social description', 'relaunch72-publisher' ); ?></label>
			<textarea id="r72pub-og-desc" name="r72pub[<?php echo esc_attr( R72Pub_Seo::F_OG_DESC ); ?>]" rows="2" maxlength="400"><?php echo esc_textarea( $v[ R72Pub_Seo::F_OG_DESC ] ); ?></textarea>
			<label for="r72pub-og-image"><?php esc_html_e( 'Social image (media library ID)', 'relaunch72-publisher' ); ?></label>
			<input type="number" min="0" id="r72pub-og-image" name="r72pub[<?php echo esc_attr( R72Pub_Seo::F_OG_IMAGE ); ?>]" value="<?php echo esc_attr( $image_id ? (string) $image_id : '' ); ?>" class="small-text" />
			<?php if ( $image_url ) : ?><br /><img src="<?php echo esc_url( $image_url ); ?>" alt="" style="max-width:200px;height:auto;margin-top:6px" /><?php endif; ?>
			<p class="r72pub-hint"><?php esc_html_e( 'Blank uses the featured image, then the site default social image. Social previews are used by Facebook, LinkedIn, X and messaging apps.', 'relaunch72-publisher' ); ?></p>
		</div>
		<script>(function(){document.querySelectorAll('.r72pub-count').forEach(function(c){var f=document.getElementById(c.getAttribute('data-for'));if(!f)return;var u=function(){c.textContent=f.value.length?f.value.length+' chars':''};f.addEventListener('input',u);u();});})();</script>
		<?php
	}

	public static function save( $post_id, $post ) {
		if ( ! isset( $_POST[ self::NONCE ] ) || ! wp_verify_nonce( sanitize_key( wp_unslash( $_POST[ self::NONCE ] ) ), self::NONCE ) ) {
			return;
		}
		if ( ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) || wp_is_post_revision( $post_id ) || wp_is_post_autosave( $post_id ) ) {
			return;
		}
		if ( ! current_user_can( 'edit_post', $post_id ) || ! in_array( $post->post_type, self::post_types(), true ) || 'standalone' !== R72Pub_Seo::status()['mode'] ) {
			return;
		}
		$in = isset( $_POST['r72pub'] ) && is_array( $_POST['r72pub'] ) ? wp_unslash( $_POST['r72pub'] ) : array(); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- each field sanitised below.
		$clean = array(
			R72Pub_Seo::F_TITLE     => mb_substr( sanitize_text_field( (string) ( $in[ R72Pub_Seo::F_TITLE ] ?? '' ) ), 0, 200 ),
			R72Pub_Seo::F_DESC      => mb_substr( sanitize_textarea_field( (string) ( $in[ R72Pub_Seo::F_DESC ] ?? '' ) ), 0, 400 ),
			R72Pub_Seo::F_CANONICAL => esc_url_raw( (string) ( $in[ R72Pub_Seo::F_CANONICAL ] ?? '' ), array( 'https', 'http' ) ),
			R72Pub_Seo::F_NOINDEX   => ! empty( $in[ R72Pub_Seo::F_NOINDEX ] ) ? '1' : '',
			R72Pub_Seo::F_NOFOLLOW  => ! empty( $in[ R72Pub_Seo::F_NOFOLLOW ] ) ? '1' : '',
			R72Pub_Seo::F_OG_TITLE  => mb_substr( sanitize_text_field( (string) ( $in[ R72Pub_Seo::F_OG_TITLE ] ?? '' ) ), 0, 200 ),
			R72Pub_Seo::F_OG_DESC   => mb_substr( sanitize_textarea_field( (string) ( $in[ R72Pub_Seo::F_OG_DESC ] ?? '' ) ), 0, 400 ),
			R72Pub_Seo::F_OG_IMAGE  => '',
		);
		$image = absint( $in[ R72Pub_Seo::F_OG_IMAGE ] ?? 0 );
		if ( $image && wp_attachment_is_image( $image ) ) {
			$clean[ R72Pub_Seo::F_OG_IMAGE ] = (string) $image;
		}
		foreach ( $clean as $key => $value ) {
			if ( '' === $value ) {
				delete_post_meta( $post_id, $key );
			} else {
				update_post_meta( $post_id, $key, wp_slash( $value ) );
			}
		}
	}
}
